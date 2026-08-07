# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-08-07

First public release.

### Added
- Per-profile proxy control for Chromium browsers (Brave, Chrome, Edge, Vivaldi):
  one browser profile is routed through your own server while every other profile
  and the rest of the system stays direct.
- Protocol support through the bundled sing-box core: VLESS (REALITY, XTLS-Vision,
  ws, grpc, httpupgrade), VMess, Trojan, Shadowsocks with ShadowTLS, Hysteria2,
  Hysteria, TUIC, AnyTLS, WireGuard, SSH, and SOCKS5 / SOCKS4 / HTTP / HTTPS
  upstream proxies, with or without authentication.
- Import from share links and base64 subscriptions; per-protocol templates in the
  profile editor.
- Rule-based routing: choose which domains use the proxy and which stay direct.
- One-click Windows installer with the networking core bundled — installation needs
  no network access.
- First-run onboarding that detects whether the background component is present and
  guides accordingly.
- Published `SHA256SUMS.txt` and Sigstore build provenance for every release.

### Security
- Destination DNS lookups are resolved through the tunnel, not by the local
  resolver.
- The proxy is fail-closed: if the background component dies, the browser profile
  loses connectivity rather than silently reverting to a direct connection.
- The extension verifies that it actually controls the browser's proxy setting and
  refuses to report an active tunnel when another extension has taken precedence.

[0.1.0]: https://github.com/MagicMaxLabs/MagicProxy/releases/tag/v0.1.0
