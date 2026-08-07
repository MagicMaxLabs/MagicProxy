// Package diag detects environmental conditions that make MagicProxy fail in ways
// the core's own error message cannot explain.
package diag

import (
	"net"
	"strings"
)

// Adapter names used by desktop proxy clients when they run in TUN mode. Matching
// is on the interface's friendly name, which on Windows is what these products set
// (Clash Verge/Mihomo -> "Mihomo", sing-box -> "sing-box", Hiddify -> "Hiddify").
var tunnelAdapterHints = []string{
	"clash", "mihomo", "meta",
	"sing-box", "singbox",
	"hiddify", "nekoray", "nekobox",
	"v2ray", "xray", "v2rayn",
	"wintun", "wireguard", "warp",
	"outline", "tun0", "utun",
}

// ActiveTunnelAdapters returns the names of network interfaces that are UP and look
// like another proxy client's TUN adapter.
//
// Why this exists: when another client runs in TUN mode it captures ALL system
// traffic, including MagicProxy's own outbound connection to the user's proxy
// server. That connection then arrives at the server through a second tunnel, and
// protocols that authenticate the peer — REALITY above all — fail with messages
// like "reality verification failed", which tell the user nothing about the actual
// cause. Detecting the adapter lets us say what is really wrong.
//
// Only interfaces that are UP count: a disconnected TAP adapter left behind by some
// VPN client is inert and must not produce a false warning.
func ActiveTunnelAdapters() []string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var found []string
	for _, i := range ifaces {
		if i.Flags&net.FlagUp == 0 {
			continue
		}
		if i.Flags&net.FlagLoopback != 0 {
			continue
		}
		name := strings.ToLower(i.Name)
		for _, hint := range tunnelAdapterHints {
			if strings.Contains(name, hint) {
				found = append(found, i.Name)
				break
			}
		}
	}
	return found
}

// LooksLikeDoubleProxying reports whether a core log line is the kind of failure
// that another client's TUN mode typically causes.
func LooksLikeDoubleProxying(line string) bool {
	l := strings.ToLower(line)
	switch {
	case strings.Contains(l, "reality verification failed"),
		strings.Contains(l, "tls: handshake failure"),
		strings.Contains(l, "bad certificate"),
		strings.Contains(l, "certificate verify failed"),
		strings.Contains(l, "unexpected eof"):
		return true
	}
	return false
}
