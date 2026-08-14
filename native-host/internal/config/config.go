// Package config translates a normalized MagicProxy profile into a sing-box
// config.json. See docs/PROTOCOL.md for the profile schema.
package config

import (
	"encoding/json"
	"fmt"
	"net"
)

// DNS server tags used in the generated config.
//
// Why two resolvers: the proxy server's OWN hostname must be resolved before the
// tunnel exists, so it has to go out directly (dnsBootstrapTag). Everything else
// resolves through the tunnel (dnsRemoteTag) so destination lookups don't leak to
// the local network. Pointing every lookup at the tunnelled resolver deadlocks —
// verified against sing-box 1.13.14: "lookup failed for <proxy host>: context
// deadline exceeded", i.e. no connection at all.
const (
	dnsRemoteTag    = "dns-remote"
	dnsBootstrapTag = "dns-bootstrap"

	// Destination lookups travel through the tunnel, so this address only has to be
	// reachable from the proxy server's side of the world.
	defaultRemoteDNS = "1.1.1.1"
)

type UTLS struct {
	Enabled     bool   `json:"enabled"`
	Fingerprint string `json:"fingerprint"`
}

type Reality struct {
	Enabled   bool   `json:"enabled"`
	PublicKey string `json:"publicKey"`
	ShortID   string `json:"shortId"`
}

type TLS struct {
	Enabled    bool     `json:"enabled"`
	ServerName string   `json:"serverName"`
	Insecure   bool     `json:"insecure"`
	ALPN       []string `json:"alpn"`
	UTLS       *UTLS    `json:"utls"`
	Reality    *Reality `json:"reality"`
}

type Transport struct {
	Type        string            `json:"type"` // ws|grpc|http|httpupgrade|quic
	Path        string            `json:"path"`
	Host        string            `json:"host"`
	ServiceName string            `json:"serviceName"`
	Headers     map[string]string `json:"headers"`
}

type Obfs struct {
	Type     string `json:"type"`
	Password string `json:"password"`
}

type Hysteria2Opts struct {
	UpMbps   int   `json:"upMbps"`
	DownMbps int   `json:"downMbps"`
	Obfs     *Obfs `json:"obfs"`
}

type Hysteria1Opts struct {
	UpMbps   int    `json:"upMbps"`
	DownMbps int    `json:"downMbps"`
	Obfs     string `json:"obfs"` // v1 obfs is a plain string
	AuthStr  string `json:"authStr"`
}

type TuicOpts struct {
	CongestionControl string `json:"congestionControl"`
	UDPRelayMode      string `json:"udpRelayMode"`
}

// ShadowTLS camouflages an inner protocol (usually Shadowsocks) behind a real
// TLS handshake. It is applied as a detour: the inner outbound loses its own
// server/port/TLS and tunnels through a separate "shadowtls" outbound.
type ShadowTLSOpts struct {
	Version  int    `json:"version"`  // 1 | 2 | 3 (default 3)
	Password string `json:"password"` // required for v2/v3
}

// WireGuard describes a single-peer WireGuard endpoint (sing-box >= 1.11 uses
// the top-level "endpoints" field for WireGuard).
type WireGuardOpts struct {
	PrivateKey    string   `json:"privateKey"`
	PeerPublicKey string   `json:"peerPublicKey"`
	PreSharedKey  string   `json:"preSharedKey"`
	LocalAddress  []string `json:"localAddress"` // e.g. ["10.0.0.2/32"]
	MTU           int      `json:"mtu"`
	Reserved      []int    `json:"reserved"`
}

type Profile struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Type     string `json:"type"`
	Server   string `json:"server"`
	Port     int    `json:"port"`
	UUID     string `json:"uuid"`
	Password string `json:"password"`
	Username string `json:"username"`
	Method   string `json:"method"`
	AlterID  int    `json:"alterId"`
	Flow     string `json:"flow"`
	// socks: "5" (default), "4", "4a". http: ignored.
	SocksVersion string `json:"socksVersion"`
	// ssh: PEM private key (alternative to password auth).
	PrivateKey string `json:"privateKey"`
	// ssh: expected server host key ("ssh-ed25519 AAAA…", as printed by
	// ssh-keyscan). Without it sing-box would accept ANY server that answers on
	// the port, and an active man-in-the-middle collects the password.
	HostKey   string         `json:"hostKey"`
	TLS       *TLS           `json:"tls"`
	Transport *Transport     `json:"transport"`
	Hysteria2 *Hysteria2Opts `json:"hysteria2"`
	Hysteria1 *Hysteria1Opts `json:"hysteria1"`
	Tuic      *TuicOpts      `json:"tuic"`
	WireGuard *WireGuardOpts `json:"wireguard"`
	ShadowTLS *ShadowTLSOpts `json:"shadowtls"`
}

type Inbound struct {
	Listen string `json:"listen"`
	Port   int    `json:"port"`
}

type Routing struct {
	Final string           `json:"final"` // "proxy" | "direct"
	Rules []map[string]any `json:"rules"`
	// RemoteDNS is the resolver used for destination lookups, reached THROUGH the
	// tunnel. Empty means defaultRemoteDNS.
	RemoteDNS string `json:"remoteDns"`
}

type obj = map[string]any

func buildTLS(t *TLS) obj {
	if t == nil || !t.Enabled {
		return nil
	}
	tls := obj{"enabled": true}
	if t.ServerName != "" {
		tls["server_name"] = t.ServerName
	}
	if t.Insecure {
		tls["insecure"] = true
	}
	if len(t.ALPN) > 0 {
		tls["alpn"] = t.ALPN
	}
	if t.UTLS != nil && t.UTLS.Enabled {
		fp := t.UTLS.Fingerprint
		if fp == "" {
			fp = "chrome"
		}
		tls["utls"] = obj{"enabled": true, "fingerprint": fp}
	}
	if t.Reality != nil && t.Reality.Enabled {
		tls["reality"] = obj{
			"enabled":    true,
			"public_key": t.Reality.PublicKey,
			"short_id":   t.Reality.ShortID,
		}
		// sing-box's REALITY client hard-requires uTLS. parse.js only sets it when
		// the share link carried fp=, so a REALITY link without that parameter
		// produced a config the core refuses to start.
		if _, ok := tls["utls"]; !ok {
			tls["utls"] = obj{"enabled": true, "fingerprint": "chrome"}
		}
	}
	return tls
}

func buildTransport(tr *Transport) obj {
	if tr == nil || tr.Type == "" {
		return nil
	}
	switch tr.Type {
	case "ws":
		t := obj{"type": "ws"}
		if tr.Path != "" {
			t["path"] = tr.Path
		}
		headers := obj{}
		if tr.Host != "" {
			headers["Host"] = tr.Host
		}
		for k, v := range tr.Headers {
			headers[k] = v
		}
		if len(headers) > 0 {
			t["headers"] = headers
		}
		return t
	case "grpc":
		name := tr.ServiceName
		if name == "" {
			name = tr.Path
		}
		return obj{"type": "grpc", "service_name": name}
	case "http", "h2":
		t := obj{"type": "http"}
		if tr.Host != "" {
			t["host"] = []string{tr.Host}
		}
		if tr.Path != "" {
			t["path"] = tr.Path
		}
		return t
	case "httpupgrade":
		t := obj{"type": "httpupgrade"}
		if tr.Path != "" {
			t["path"] = tr.Path
		}
		if tr.Host != "" {
			t["host"] = tr.Host
		}
		return t
	case "quic":
		return obj{"type": "quic"}
	}
	return nil
}

// transportSupported reports whether buildTransport can express this transport.
// Anything else (xhttp, kcp, splithttp, …) was previously dropped silently, which
// produced a plain-TCP outbound: `check` passed, the badge went green, and nothing
// ever connected. Failing loudly is the only honest option.
func transportSupported(tr *Transport) bool {
	if tr == nil || tr.Type == "" {
		return true // no transport requested
	}
	switch tr.Type {
	case "ws", "grpc", "http", "h2", "httpupgrade", "quic":
		return true
	}
	return false
}

// resolveHost returns host unchanged when it is already a literal IP, otherwise
// resolves it, preferring IPv4.
func resolveHost(host string) (string, error) {
	if ip := net.ParseIP(host); ip != nil {
		return host, nil
	}
	addrs, err := net.LookupIP(host)
	if err != nil {
		return "", fmt.Errorf("cannot resolve %q: %w", host, err)
	}
	for _, a := range addrs {
		if v4 := a.To4(); v4 != nil {
			return v4.String(), nil
		}
	}
	if len(addrs) > 0 {
		return addrs[0].String(), nil
	}
	return "", fmt.Errorf("no addresses found for %q", host)
}

func buildWireGuardEndpoint(p *Profile) (obj, error) {
	wg := p.WireGuard
	if wg == nil || wg.PrivateKey == "" || wg.PeerPublicKey == "" {
		return nil, fmt.Errorf("wireguard requires privateKey and peerPublicKey")
	}
	addr := wg.LocalAddress
	if len(addr) == 0 {
		addr = []string{"172.16.0.2/32"}
	}
	// The peer address must be a literal IP. sing-box resolves a domain peer with
	// the endpoint's own domain_resolver, which we point through the tunnel — and
	// that deadlocks ("WireGuard is not ready yet", verified on 1.13.14). Resolving
	// here is also honest: WireGuard packets cannot be sent anywhere until this
	// lookup happens, so it is unavoidable and must go out directly.
	peerAddr, err := resolveHost(p.Server)
	if err != nil {
		return nil, err
	}
	peer := obj{
		"address":     peerAddr,
		"port":        p.Port,
		"public_key":  wg.PeerPublicKey,
		"allowed_ips": []string{"0.0.0.0/0", "::/0"},
	}
	if wg.PreSharedKey != "" {
		peer["pre_shared_key"] = wg.PreSharedKey
	}
	if len(wg.Reserved) > 0 {
		peer["reserved"] = wg.Reserved
	}
	ep := obj{
		"type":        "wireguard",
		"tag":         "proxy",
		"address":     addr,
		"private_key": wg.PrivateKey,
		// Destination lookups go through the tunnel; without this they fall back to
		// the system resolver and every visited hostname leaks in cleartext.
		"domain_resolver": dnsRemoteTag,
		"peers":           []obj{peer},
	}
	if wg.MTU > 0 {
		ep["mtu"] = wg.MTU
	}
	return ep, nil
}

// buildProxy returns the proxy outbound(s) and/or endpoint(s) for a profile.
// Most protocols yield a single outbound tagged "proxy"; WireGuard yields an
// endpoint (also tagged "proxy") instead.
func buildProxy(p *Profile) (outbounds []obj, endpoints []obj, err error) {
	if p.Type == "wireguard" {
		ep, e := buildWireGuardEndpoint(p)
		if e != nil {
			return nil, nil, e
		}
		return nil, []obj{ep}, nil
	}

	if !transportSupported(p.Transport) {
		return nil, nil, fmt.Errorf("транспорт %q не поддерживается (доступны ws, grpc, http, httpupgrade, quic)", p.Transport.Type)
	}

	out := obj{"tag": "proxy", "server": p.Server, "server_port": p.Port}
	tls := buildTLS(p.TLS)
	tr := buildTransport(p.Transport)

	switch p.Type {
	case "vless":
		out["type"] = "vless"
		out["uuid"] = p.UUID
		// XTLS Vision is the only flow sing-box accepts, and it requires a raw TLS
		// connection: it cannot run over a v2ray transport and cannot run without
		// TLS. Panels commonly emit flow=none (fatal) or attach flow to ws/grpc
		// links (accepted by `sing-box check`, then black-holes every connection).
		// Dropping an unusable flow still connects to the same server — Vision is an
		// optimisation, not a requirement — so drop rather than fail.
		if p.Flow == "xtls-rprx-vision" && tls != nil && tr == nil {
			out["flow"] = p.Flow
		}
		out["packet_encoding"] = "xudp"
	case "vmess":
		out["type"] = "vmess"
		out["uuid"] = p.UUID
		out["alter_id"] = p.AlterID
		out["security"] = "auto"
	case "trojan":
		out["type"] = "trojan"
		out["password"] = p.Password
	case "shadowsocks":
		out["type"] = "shadowsocks"
		out["method"] = p.Method
		out["password"] = p.Password
		tls = nil
		tr = nil
	case "anytls":
		out["type"] = "anytls"
		out["password"] = p.Password
		if tls == nil {
			tls = obj{"enabled": true, "server_name": p.Server}
		}
		tr = nil
	case "hysteria2":
		out["type"] = "hysteria2"
		out["password"] = p.Password
		if p.Hysteria2 != nil {
			if p.Hysteria2.UpMbps > 0 {
				out["up_mbps"] = p.Hysteria2.UpMbps
			}
			if p.Hysteria2.DownMbps > 0 {
				out["down_mbps"] = p.Hysteria2.DownMbps
			}
			// An obfs block with an empty password is fatal to sing-box, and the
			// shipped Hysteria2 template contained exactly that stub — so the
			// default template could not start.
			if p.Hysteria2.Obfs != nil && p.Hysteria2.Obfs.Type != "" && p.Hysteria2.Obfs.Password != "" {
				out["obfs"] = obj{
					"type":     p.Hysteria2.Obfs.Type,
					"password": p.Hysteria2.Obfs.Password,
				}
			}
		}
		if tls == nil {
			tls = obj{"enabled": true, "server_name": p.Server}
		}
		tr = nil
	case "hysteria":
		out["type"] = "hysteria"
		authStr := p.Password
		if p.Hysteria1 != nil && p.Hysteria1.AuthStr != "" {
			authStr = p.Hysteria1.AuthStr
		}
		if authStr != "" {
			out["auth_str"] = authStr
		}
		// sing-box REQUIRES both speeds for hysteria v1 ("missing upload speed" is
		// fatal), but most hysteria:// share links omit them, and parse.js then
		// yields 0. Emitting nothing made the whole protocol unusable, so default.
		up, down := 10, 50
		if p.Hysteria1 != nil {
			if p.Hysteria1.UpMbps > 0 {
				up = p.Hysteria1.UpMbps
			}
			if p.Hysteria1.DownMbps > 0 {
				down = p.Hysteria1.DownMbps
			}
			if p.Hysteria1.Obfs != "" {
				out["obfs"] = p.Hysteria1.Obfs
			}
		}
		out["up_mbps"] = up
		out["down_mbps"] = down
		if tls == nil {
			tls = obj{"enabled": true, "server_name": p.Server}
		}
		tr = nil
	case "tuic":
		out["type"] = "tuic"
		out["uuid"] = p.UUID
		out["password"] = p.Password
		if p.Tuic != nil {
			if p.Tuic.CongestionControl != "" {
				out["congestion_control"] = p.Tuic.CongestionControl
			}
			if p.Tuic.UDPRelayMode != "" {
				out["udp_relay_mode"] = p.Tuic.UDPRelayMode
			}
		}
		if tls == nil {
			tls = obj{"enabled": true, "server_name": p.Server, "alpn": []string{"h3"}}
		}
		tr = nil
	case "ssh":
		out["type"] = "ssh"
		if p.Username != "" {
			out["user"] = p.Username
		}
		if p.Password != "" {
			out["password"] = p.Password
		}
		if p.PrivateKey != "" {
			out["private_key"] = p.PrivateKey
		}
		// Fail-closed, как и всё остальное: SSH без проверки ключа хоста — это
		// туннель, который отдаёт пароль первому же перехватчику на пути. Запуск
		// без ключа запрещён, а не «разрешён с предупреждением»: предупреждений
		// в логах никто не читает. Текст стабилен — попап узнаёт его по префиксу
		// "ssh: hostKey is not set" и показывает перевод (humanError).
		if p.HostKey == "" {
			return nil, nil, fmt.Errorf(
				"ssh: hostKey is not set. Run \"ssh-keyscan -t ed25519 <server>\" " +
					"and paste the \"ssh-ed25519 AAAA…\" line into the profile's hostKey field")
		}
		out["host_key"] = []string{p.HostKey}
		tls = nil
		tr = nil
	case "socks":
		out["type"] = "socks"
		ver := p.SocksVersion
		if ver == "" {
			ver = "5"
		}
		out["version"] = ver
		if p.Username != "" {
			out["username"] = p.Username
			out["password"] = p.Password
		}
		tls = nil
		tr = nil
	case "http":
		out["type"] = "http"
		if p.Username != "" {
			out["username"] = p.Username
			out["password"] = p.Password
		}
		// TLS (attached below if enabled) turns this into an HTTPS proxy.
		tr = nil
	default:
		return nil, nil, fmt.Errorf("unsupported profile type: %q", p.Type)
	}

	if tls != nil {
		out["tls"] = tls
	}
	if tr != nil {
		out["transport"] = tr
	}

	// ShadowTLS wrapping: the inner protocol tunnels through a shadowtls detour
	// which owns the real connection + TLS camouflage.
	if p.ShadowTLS != nil && shadowTLSInner(p.Type) {
		delete(out, "server")
		delete(out, "server_port")
		delete(out, "tls")
		delete(out, "transport")
		out["detour"] = "shadowtls-detour"

		ver := p.ShadowTLS.Version
		if ver == 0 {
			ver = 3
		}
		stlsTLS := buildTLS(p.TLS)
		if stlsTLS == nil {
			stlsTLS = obj{"enabled": true, "server_name": p.Server}
		}
		stls := obj{
			"type":        "shadowtls",
			"tag":         "shadowtls-detour",
			"server":      p.Server,
			"server_port": p.Port,
			"version":     ver,
			"tls":         stlsTLS,
		}
		if p.ShadowTLS.Password != "" {
			stls["password"] = p.ShadowTLS.Password
		}
		return []obj{out, stls}, nil, nil
	}

	return []obj{out}, nil, nil
}

// shadowTLSInner reports whether a protocol can sit behind a ShadowTLS detour.
func shadowTLSInner(t string) bool {
	switch t {
	case "shadowsocks", "trojan", "vmess", "vless":
		return true
	}
	return false
}

// Build produces a complete sing-box config for the profile with a mixed
// (SOCKS5 + HTTP) inbound on the given port.
func Build(p *Profile, in Inbound, routing Routing, logLevel string) ([]byte, error) {
	if p.Server == "" || p.Port == 0 {
		return nil, fmt.Errorf("profile is missing server/port")
	}
	proxyOuts, endpoints, err := buildProxy(p)
	if err != nil {
		return nil, err
	}

	listen := in.Listen
	if listen == "" {
		listen = "127.0.0.1"
	}

	final := routing.Final
	if final != "direct" {
		final = "proxy"
	}

	remoteDNS := routing.RemoteDNS
	if remoteDNS == "" {
		remoteDNS = defaultRemoteDNS
	}

	// "warn" by default: at "info" sing-box logs roughly three lines per TCP
	// connection, each naming the destination host, and every one of those becomes
	// a native-messaging frame the extension has to read and keep.
	switch logLevel {
	case "trace", "debug", "info", "warn", "error", "fatal", "panic":
	default:
		logLevel = "warn"
	}

	// Always keep LAN/private traffic off the tunnel. Uses the modern
	// action-based rule form (sing-box >= 1.11) so auto-updates to newer cores
	// don't break on the removal of the legacy bare-"outbound" rule syntax.
	rules := []obj{
		// Name-based first: ip_is_private is evaluated on the destination ADDRESS,
		// and sing-box does not resolve domain destinations, so an intranet FQDN
		// would otherwise be tunnelled to the remote server. Matching on the name
		// avoids that without forcing a lookup for every destination.
		{
			"domain_suffix": []string{".local", ".lan", ".home", ".home.arpa", ".internal", ".intranet"},
			"action":        "route",
			"outbound":      "direct",
		},
		{"ip_is_private": true, "action": "route", "outbound": "direct"},
	}
	for _, r := range routing.Rules {
		rules = append(rules, obj(r))
	}

	outbounds := append(proxyOuts, obj{"type": "direct", "tag": "direct"})

	cfg := obj{
		"log": obj{"level": logLevel, "timestamp": true},
		"dns": obj{
			"servers": []obj{
				{"type": "udp", "tag": dnsRemoteTag, "server": remoteDNS, "detour": "proxy"},
				// The bootstrap resolver only ever resolves the proxy server's own
				// hostname, and it must work BEFORE the tunnel exists. Using the OS
				// resolver ("local") rather than a hardcoded public IP is deliberate:
				// plaintext UDP/53 to a foreign resolver is exactly what gets blocked
				// on the networks this product exists for, and a blocked bootstrap
				// means the core starts, the badge turns green, and every page then
				// hangs — the most demoralising possible failure.
				{"type": "local", "tag": dnsBootstrapTag},
			},
			"strategy": "prefer_ipv4",
			"final":    dnsRemoteTag,
		},
		"inbounds": []obj{
			{
				"type":        "mixed",
				"tag":         "in",
				"listen":      listen,
				"listen_port": in.Port,
			},
		},
		"outbounds": outbounds,
		"route": obj{
			"rules": rules,
			"final": final,
			// Resolves outbound server hostnames. Must NOT go through the tunnel:
			// reaching the proxy requires knowing its address first.
			"default_domain_resolver": obj{"server": dnsBootstrapTag},
		},
	}
	if len(endpoints) > 0 {
		cfg["endpoints"] = endpoints
	}

	return json.MarshalIndent(cfg, "", "  ")
}
