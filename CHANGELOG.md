# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-08-14

### Added
- English interface. The extension now ships in English and Russian
  (`_locales`, `chrome.i18n`); the browser's UI language picks the locale.
- WebRTC leak protection: while the proxy is on, the profile's WebRTC policy is
  set to `disable_non_proxied_udp` (new `privacy` permission), so pages cannot
  learn your real IP from ICE candidates. Removed when the proxy is off.
- Profile export to JSON, and a confirmation before deleting a profile.
- SSH profiles verify the server's host key (`hostKey` is now required) and
  refuse to start without it.
- Import deduplication: re-importing a subscription no longer duplicates
  profiles.

### Changed
- Rules mode (PAC) is fail-closed: a PAC failure now blocks traffic instead of
  silently falling back to a direct connection.
- `*.example.com` in routing rules now also matches `example.com`.
- Bundled sing-box core: v1.13.14 → v1.13.16; its download is verified against
  a pinned SHA-256 in CI and setup.ps1.
- "Update core" switches the proxy back on afterwards, and refuses a
  major-version jump of the core (that ships with a MagicProxy release).
- Harmless core log lines about client-closed connections are no longer shown
  as errors.
- After installation the setup wizard opens the Chrome Web Store listing.
- Minimum Chrome version: 116 → 120 (the 30-second self-heal alarm needs 120).

### Fixed
- Modern `ss://` links (SIP022 / 2022-blake3 ciphers) import correctly;
  passwords containing colons survive in `ss://` and `hysteria2://` links;
  `allowInsecure=true` is honored; Hysteria v1 sends the obfuscation secret
  from `obfsParam=` instead of the method name.
- Pasting an existing profile's JSON into "New profile" no longer overwrites
  the original.
- The generated core configuration (which contains server credentials) is
  deleted when the proxy stops and when the host exits, and both uninstallers
  remove any leftovers; each host process now uses its own working directory.
- Checking for core updates can no longer freeze the background component on
  networks where GitHub stalls.
- A deliberate core stop no longer flashes the toolbar dot red.

## [0.1.0] - 2026-08-08

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
- The networking core is bound to the background component through a Windows job
  object, so it is torn down even when that component is killed outright and can
  never be left running with a stale configuration.
- The extension verifies that it actually controls the browser's proxy setting and
  refuses to report an active tunnel when another extension has taken precedence.

[0.1.0]: https://github.com/MagicMaxLabs/MagicProxy/releases/tag/v0.1.0
