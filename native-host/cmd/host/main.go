// Command host is the MagicProxy Native Messaging host. Chrome/Brave launches it
// automatically when the extension connects; it manages a sing-box process and
// exposes a local SOCKS5+HTTP endpoint.
package main

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
	"sync/atomic"

	"magicproxy/internal/config"
	"magicproxy/internal/core"
	"magicproxy/internal/diag"
	"magicproxy/internal/messaging"
	"magicproxy/internal/updater"
)

// Overridden at build time by CI: -ldflags "-X main.hostVersion=<tag>".
var hostVersion = "0.0.0-dev"

type startPayload struct {
	Profile  config.Profile `json:"profile"`
	Inbound  config.Inbound `json:"inbound"`
	Routing  config.Routing `json:"routing"`
	LogLevel string         `json:"logLevel"`
}

func main() {
	conn := messaging.NewConn(os.Stdin, os.Stdout)

	// Before anything is spawned: make the operating system responsible for
	// killing sing-box when this host dies. Stop() only covers the orderly exits.
	if err := core.ConfineChildren(); err != nil {
		_ = conn.Emit("log", map[string]any{
			"level": "warn",
			"line": "MagicProxy: не удалось привязать ядро к процессу хоста (" + err.Error() +
				"). Если хост завершится аварийно, sing-box может остаться в памяти.",
		})
	}

	mgr, err := core.NewManager()
	if err != nil {
		// We can still speak the protocol; report the failure on first request.
		runWithoutCore(conn, err)
		return
	}

	// Forward sing-box logs and exit events to the extension.
	//
	// When a failure looks like another client's TUN mode capturing our own
	// outbound connection, append a plain-language explanation. The core's message
	// ("reality verification failed") is accurate but gives the user no way to
	// guess the real cause, and this is a common setup: our audience frequently
	// already runs Clash/Hiddify/v2rayN.
	hintedThisRun := false
	mgr.OnLog = func(level, line string) {
		_ = conn.Emit("log", map[string]any{"level": level, "line": line})
		if hintedThisRun || !diag.LooksLikeDoubleProxying(line) {
			return
		}
		if adapters := diag.ActiveTunnelAdapters(); len(adapters) > 0 {
			hintedThisRun = true
			_ = conn.Emit("log", map[string]any{
				"level": "error",
				"line": "MagicProxy: обнаружен активный TUN-адаптер (" + strings.Join(adapters, ", ") +
					"). Другой прокси-клиент перехватывает весь трафик системы, включая наше " +
					"соединение с твоим сервером — из-за двойного проксирования проверка не проходит. " +
					"Переключи тот клиент в обычный режим прокси или добавь адрес твоего сервера в его обход.",
			})
		}
	}
	mgr.OnExit = func(err error) {
		payload := map[string]any{"running": false}
		if err != nil {
			payload["error"] = err.Error()
		}
		_ = conn.Emit("state", payload)
	}

	for {
		req, err := conn.Read()
		if err != nil {
			if errors.Is(err, io.EOF) {
				break // extension disconnected: Chrome will terminate us
			}
			break
		}
		handle(conn, mgr, req)
	}

	_ = mgr.Stop()
	// Конфиг с паролями не должен переживать процесс, который его написал.
	mgr.Cleanup()
}

// updateBusy предотвращает два одновременных updateCore: команды выполняются в
// горутинах (см. handle), и без замка второй клик по кнопке гонялся бы с первым
// за один и тот же .exe.
var updateBusy atomic.Bool

func handle(conn *messaging.Conn, mgr *core.Manager, req *messaging.Request) {
	switch req.Type {
	case "ping":
		_ = conn.Respond(req.ID, map[string]any{"pong": true})

	case "version":
		_ = conn.Respond(req.ID, map[string]any{
			"host":    hostVersion,
			"singbox": mgr.Version(),
		})

	case "status":
		running, port, uptime := mgr.Status()
		_ = conn.Respond(req.ID, map[string]any{
			"running":   running,
			"port":      port,
			"uptimeSec": uptime,
		})

	case "test":
		var p struct {
			Profile config.Profile `json:"profile"`
		}
		if err := json.Unmarshal(req.Payload, &p); err != nil {
			_ = conn.RespondError(req.ID, err)
			return
		}
		cfg, err := config.Build(&p.Profile, config.Inbound{Listen: "127.0.0.1", Port: 1080}, config.Routing{}, "warn")
		if err != nil {
			_ = conn.RespondError(req.ID, err)
			return
		}
		if err := mgr.Check(cfg); err != nil {
			_ = conn.RespondError(req.ID, err)
			return
		}
		_ = conn.Respond(req.ID, map[string]any{"valid": true})

	case "start":
		var pl startPayload
		if err := json.Unmarshal(req.Payload, &pl); err != nil {
			_ = conn.RespondError(req.ID, err)
			return
		}
		// Stop any current instance first so it releases its port — otherwise
		// ResolvePort would see the requested port as taken and pick a new one.
		_ = mgr.Stop()
		// Reuse the requested port when free (stable across restarts), else pick a
		// fresh one and report it back so the extension can re-point chrome.proxy.
		port, err := core.ResolvePort(pl.Inbound.Port)
		if err != nil {
			_ = conn.RespondError(req.ID, err)
			return
		}
		listen := pl.Inbound.Listen
		if listen == "" {
			listen = "127.0.0.1"
		}
		// LogLevel was previously declared and then never used, so the level stayed
		// hardcoded at "info" — which logs every connection's hostname.
		cfg, err := config.Build(&pl.Profile, config.Inbound{Listen: listen, Port: port}, pl.Routing, pl.LogLevel)
		if err != nil {
			_ = conn.RespondError(req.ID, err)
			return
		}
		if err := mgr.Start(cfg, port); err != nil {
			_ = conn.RespondError(req.ID, err)
			return
		}
		_ = conn.Respond(req.ID, map[string]any{
			"listen": listen,
			"port":   port,
			"socks":  true,
			"http":   true,
		})

	case "stop":
		if err := mgr.Stop(); err != nil {
			_ = conn.RespondError(req.ID, err)
			return
		}
		_ = conn.Respond(req.ID, map[string]any{"stopped": true})

	// Обе команды обновления ходят в сеть и выполняются в горутине: handle()
	// вызывается из единственного цикла чтения, и синхронный сетевой запрос
	// (даже с таймаутом — это десятки секунд) молчал бы на ping/status/stop,
	// то есть ломал всю механику живучести. Запись в Conn под мьютексом,
	// параллельные ответы безопасны.
	case "checkUpdate":
		go func(id string) {
			current := updater.NormalizeVersion(mgr.Version())
			tag, url, err := updater.LatestSingBox()
			if err != nil {
				_ = conn.RespondError(id, err)
				return
			}
			latest := updater.NormalizeVersion(tag)
			_ = conn.Respond(id, map[string]any{
				"current":         current,
				"latest":          latest,
				"updateAvailable": current != "" && latest != "" && current != latest,
				"downloadUrl":     url,
			})
		}(req.ID)

	case "updateCore":
		if !updateBusy.CompareAndSwap(false, true) {
			_ = conn.RespondError(req.ID, errors.New("обновление уже выполняется"))
			return
		}
		go func(id string) {
			defer updateBusy.Store(false)
			tag, url, err := updater.LatestSingBox()
			if err != nil {
				_ = conn.RespondError(id, err)
				return
			}
			if url == "" {
				_ = conn.RespondError(id, errors.New("no downloadable asset found"))
				return
			}
			// Stop sing-box so the binary isn't locked, then replace it.
			_ = mgr.Stop()
			if err := updater.InstallSingBox(url, mgr.SingBoxPath()); err != nil {
				_ = conn.RespondError(id, err)
				return
			}
			_ = conn.Respond(id, map[string]any{
				"updated": true,
				"version": updater.NormalizeVersion(tag),
			})
		}(req.ID)

	default:
		_ = conn.RespondError(req.ID, errors.New("unknown request type: "+req.Type))
	}
}

// runWithoutCore keeps the protocol alive but fails every actionable request
// with the initialization error (e.g. sing-box binary missing).
func runWithoutCore(conn *messaging.Conn, initErr error) {
	for {
		req, err := conn.Read()
		if err != nil {
			return
		}
		switch req.Type {
		case "ping":
			_ = conn.Respond(req.ID, map[string]any{"pong": true})
		case "version":
			_ = conn.Respond(req.ID, map[string]any{"host": hostVersion, "singbox": "unavailable"})
		default:
			_ = conn.RespondError(req.ID, initErr)
		}
	}
}
