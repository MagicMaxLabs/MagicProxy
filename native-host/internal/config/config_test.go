package config

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Профили-образцы — по одному на каждую ветку генератора. Значения фиктивные,
// но структурно правильные: цель — чтобы sing-box check принял каждый конфиг.
// sing-box check проверяет только синтаксис (грабля №1), поэтому это нижняя
// планка, а не приёмка; но именно она ловит «конфиг, который не стартует».
var sampleProfiles = map[string]*Profile{
	"vless-reality-vision": {
		Type: "vless", Server: "example.com", Port: 443,
		UUID: "9d0b5c50-4e6f-4a3e-8b3a-000000000001", Flow: "xtls-rprx-vision",
		TLS: &TLS{Enabled: true, ServerName: "www.microsoft.com",
			UTLS:    &UTLS{Enabled: true, Fingerprint: "chrome"},
			Reality: &Reality{Enabled: true, PublicKey: "SborczpZmSdCdZbKwZZJtsFOnZ3EcSGb2XkcHS3zSEE", ShortID: "6ba85179e30d4fc2"}},
	},
	// REALITY без явного uTLS: buildTLS обязан включить его сам, иначе ядро
	// отказывает (проверка фикса P1-9).
	"vless-reality-no-fp": {
		Type: "vless", Server: "example.com", Port: 443,
		UUID: "9d0b5c50-4e6f-4a3e-8b3a-000000000002",
		TLS: &TLS{Enabled: true, ServerName: "www.microsoft.com",
			Reality: &Reality{Enabled: true, PublicKey: "SborczpZmSdCdZbKwZZJtsFOnZ3EcSGb2XkcHS3zSEE", ShortID: "6ba85179e30d4fc2"}},
	},
	// flow вместе с ws: генератор обязан МОЛЧА отбросить flow (P1-8), конфиг —
	// пройти check.
	"vless-ws-flow-dropped": {
		Type: "vless", Server: "example.com", Port: 443,
		UUID: "9d0b5c50-4e6f-4a3e-8b3a-000000000003", Flow: "xtls-rprx-vision",
		TLS:       &TLS{Enabled: true, ServerName: "example.com"},
		Transport: &Transport{Type: "ws", Path: "/ws", Host: "example.com"},
	},
	"vless-grpc": {
		Type: "vless", Server: "example.com", Port: 443,
		UUID:      "9d0b5c50-4e6f-4a3e-8b3a-000000000004",
		TLS:       &TLS{Enabled: true, ServerName: "example.com"},
		Transport: &Transport{Type: "grpc", ServiceName: "grpc"},
	},
	"vless-httpupgrade": {
		Type: "vless", Server: "example.com", Port: 443,
		UUID:      "9d0b5c50-4e6f-4a3e-8b3a-000000000005",
		TLS:       &TLS{Enabled: true, ServerName: "example.com"},
		Transport: &Transport{Type: "httpupgrade", Path: "/up", Host: "example.com"},
	},
	"vmess-ws": {
		Type: "vmess", Server: "example.com", Port: 443,
		UUID:      "9d0b5c50-4e6f-4a3e-8b3a-000000000006",
		TLS:       &TLS{Enabled: true, ServerName: "example.com"},
		Transport: &Transport{Type: "ws", Path: "/", Host: "example.com"},
	},
	"trojan": {
		Type: "trojan", Server: "example.com", Port: 443, Password: "pw",
		TLS: &TLS{Enabled: true, ServerName: "example.com"},
	},
	"shadowsocks-2022": {
		Type: "shadowsocks", Server: "example.com", Port: 8388,
		Method: "2022-blake3-aes-128-gcm", Password: "WTx1mmB6JR4EMOgbEJDlDg==",
	},
	"shadowsocks-shadowtls": {
		Type: "shadowsocks", Server: "example.com", Port: 443,
		Method: "2022-blake3-aes-128-gcm", Password: "WTx1mmB6JR4EMOgbEJDlDg==",
		TLS:       &TLS{Enabled: true, ServerName: "www.microsoft.com", UTLS: &UTLS{Enabled: true, Fingerprint: "chrome"}},
		ShadowTLS: &ShadowTLSOpts{Version: 3, Password: "stls-pw"},
	},
	"hysteria2-obfs": {
		Type: "hysteria2", Server: "example.com", Port: 443, Password: "pw",
		TLS:       &TLS{Enabled: true, ServerName: "example.com"},
		Hysteria2: &Hysteria2Opts{UpMbps: 50, DownMbps: 200, Obfs: &Obfs{Type: "salamander", Password: "opw"}},
	},
	// Пустой пароль obfs: блок обязан быть опущен (P1-10), конфиг — валиден.
	"hysteria2-empty-obfs": {
		Type: "hysteria2", Server: "example.com", Port: 443, Password: "pw",
		TLS:       &TLS{Enabled: true, ServerName: "example.com"},
		Hysteria2: &Hysteria2Opts{Obfs: &Obfs{Type: "salamander", Password: ""}},
	},
	// Без полосы: дефолт 10/50 обязателен, иначе ядро отказывает (P1-11).
	"hysteria1-defaults": {
		Type: "hysteria", Server: "example.com", Port: 443,
		TLS:       &TLS{Enabled: true, ServerName: "example.com"},
		Hysteria1: &Hysteria1Opts{AuthStr: "auth", Obfs: "obfs-secret"},
	},
	"tuic": {
		Type: "tuic", Server: "example.com", Port: 443,
		UUID: "9d0b5c50-4e6f-4a3e-8b3a-000000000007", Password: "pw",
		TLS:  &TLS{Enabled: true, ServerName: "example.com", ALPN: []string{"h3"}},
		Tuic: &TuicOpts{CongestionControl: "bbr", UDPRelayMode: "native"},
	},
	"anytls": {
		Type: "anytls", Server: "example.com", Port: 443, Password: "pw",
		TLS: &TLS{Enabled: true, ServerName: "example.com"},
	},
	// Сервер задан IP: resolveHost не ходит в сеть, тест детерминирован.
	"wireguard": {
		Type: "wireguard", Server: "162.159.192.1", Port: 2408,
		WireGuard: &WireGuardOpts{
			PrivateKey:    "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=",
			PeerPublicKey: "bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=",
			LocalAddress:  []string{"172.16.0.2/32"}, MTU: 1408},
	},
	"ssh": {
		Type: "ssh", Server: "example.com", Port: 22, Username: "root", Password: "pw",
		HostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKzC1r5s5W3Q8Yk3P1YQxO1r5s5W3Q8Yk3P1YQxO1r5s",
	},
	"socks5-auth": {
		Type: "socks", Server: "example.com", Port: 1080, SocksVersion: "5",
		Username: "u", Password: "p",
	},
	"http-proxy": {
		Type: "http", Server: "example.com", Port: 8080, Username: "u", Password: "p",
	},
	"https-proxy": {
		Type: "http", Server: "example.com", Port: 443,
		TLS: &TLS{Enabled: true, ServerName: "example.com"},
	},
}

func singBoxPath(t *testing.T) string {
	t.Helper()
	// Тест лежит в native-host/internal/config; ядро — в vendor-bin репозитория.
	p, err := filepath.Abs(filepath.Join("..", "..", "..", "vendor-bin", "sing-box.exe"))
	if err != nil {
		t.Fatalf("abs: %v", err)
	}
	if _, err := os.Stat(p); err != nil {
		t.Skipf("sing-box.exe not present at %s — Build-only run (CI runs vet/test before downloading the core)", p)
	}
	return p
}

// TestBuildAllProtocols прогоняет каждый профиль-образец через Build и, когда
// ядро доступно, через настоящий `sing-box check`.
func TestBuildAllProtocols(t *testing.T) {
	bin := singBoxPath(t)
	dir := t.TempDir()
	for name, p := range sampleProfiles {
		t.Run(name, func(t *testing.T) {
			cfg, err := Build(p, Inbound{Listen: "127.0.0.1", Port: 18080}, Routing{}, "warn")
			if err != nil {
				t.Fatalf("Build: %v", err)
			}
			path := filepath.Join(dir, name+".json")
			if err := os.WriteFile(path, cfg, 0o600); err != nil {
				t.Fatal(err)
			}
			out, err := exec.Command(bin, "check", "-c", path).CombinedOutput()
			if err != nil {
				t.Fatalf("sing-box check rejected the config: %v\n%s\n--- config ---\n%s", err, out, cfg)
			}
		})
	}
}

// TestBuildRejects: то, что обязано отклоняться, отклоняется с внятной ошибкой.
func TestBuildRejects(t *testing.T) {
	cases := map[string]*Profile{
		"ssh-without-hostkey": {Type: "ssh", Server: "example.com", Port: 22, Username: "root", Password: "pw"},
		"unknown-transport":   {Type: "vless", Server: "example.com", Port: 443, UUID: "9d0b5c50-4e6f-4a3e-8b3a-00000000000f", Transport: &Transport{Type: "kcp"}},
		"wireguard-no-keys":   {Type: "wireguard", Server: "162.159.192.1", Port: 2408, WireGuard: &WireGuardOpts{}},
		"unknown-type":        {Type: "quantum", Server: "example.com", Port: 443},
	}
	for name, p := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := Build(p, Inbound{Listen: "127.0.0.1", Port: 18080}, Routing{}, "warn"); err == nil {
				t.Fatal("Build accepted a profile it must reject")
			}
		})
	}
}

// TestFlowDropped: flow при ws-транспорте не должен попадать в конфиг (P1-8).
func TestFlowDropped(t *testing.T) {
	cfg, err := Build(sampleProfiles["vless-ws-flow-dropped"], Inbound{Listen: "127.0.0.1", Port: 18080}, Routing{}, "warn")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(cfg), "xtls-rprx-vision") {
		t.Fatal("flow leaked into a ws-transport config")
	}
}
