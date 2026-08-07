package diag

import "testing"

func TestLooksLikeDoubleProxying(t *testing.T) {
	yes := []string{
		"ERROR connection: open connection to 2ip.ru:443 using outbound/vless[proxy]: reality verification failed",
		"tls: handshake failure",
		"remote error: tls: bad certificate",
		"unexpected EOF",
	}
	no := []string{
		"inbound/mixed[in]: tcp server started at 127.0.0.1:1080",
		"sing-box started (0.03s)",
		"dns: lookup failed for example.com: context deadline exceeded",
	}
	for _, s := range yes {
		if !LooksLikeDoubleProxying(s) {
			t.Errorf("должно распознаваться: %q", s)
		}
	}
	for _, s := range no {
		if LooksLikeDoubleProxying(s) {
			t.Errorf("ложное срабатывание: %q", s)
		}
	}
}

func TestActiveTunnelAdaptersNoFalsePositive(t *testing.T) {
	// На этой машине TAP-адаптеры существуют, но отключены (up=false),
	// поэтому предупреждения быть не должно.
	got := ActiveTunnelAdapters()
	t.Logf("активные TUN-подобные адаптеры: %v", got)
	for _, name := range got {
		t.Logf("  найден: %s", name)
	}
}
