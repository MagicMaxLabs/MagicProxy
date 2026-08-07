# Security Policy

## Reporting a vulnerability

Report security issues privately through GitHub Security Advisories
("Report a vulnerability" in the Security tab of this repository), or by email to
**magicmaxlabs@gmail.com**. Please do not open a public issue for a security
problem. Expect a first response within 7 days.

## Supported versions

Only the latest released version receives security fixes.

---

## What MagicProxy protects against — and what it does not

MagicProxy routes the traffic of **one browser profile** through a proxy server
**you provide**. Be precise about what that means before you rely on it.

**It is not anonymity.** This is not Tor. The operator of your proxy server sees
where you connect, and your IP address is visible to that server. MagicProxy
relocates your exit point; it does not hide you from the exit point. If your threat
model requires anonymity rather than IP relocation, use a tool designed for that.

**It covers one browser profile — deliberately.** Other browser profiles, other
browsers, and every other application on your computer keep their normal
connection. That is the entire point of the product, but it means "MagicProxy is
on" never means "this machine is proxied".

**WebRTC can still reveal your real IP.** Chromium's WebRTC stack sends UDP
directly and is not governed by proxy settings. A page that uses WebRTC may observe
your real address even while the proxy is on. If that matters to you, disable
WebRTC or use an extension that blocks it. MagicProxy does not currently manage
this, and we would rather say so than let you assume otherwise.

**DNS.** Destination hostnames are resolved through the tunnel, so they are not
exposed to your local network. One exception is unavoidable: the hostname of your
own proxy server is resolved locally by your operating system's resolver, because
that lookup has to happen before the tunnel exists. Use a server address that is
not itself subject to DNS interference, or specify it by IP.

**Credentials are stored unencrypted on your device.** Server addresses, UUIDs,
passwords and keys live in this browser profile's `chrome.storage.local`, protected
only by your operating-system account. Anyone with access to your unlocked Windows
user session can read them. While the proxy runs, a generated core configuration
containing the same values also exists in a temporary directory.

**The proxy is fail-closed by design.** If the background component dies while the
proxy is on, the browser profile keeps pointing at the (now dead) local endpoint
rather than silently falling back to a direct connection. You will lose
connectivity in that profile instead of leaking traffic. This is intentional.

---

## Supply chain

The networking core is [sing-box](https://github.com/SagerNet/sing-box) by SagerNet
(GPL-3.0-or-later). It is **bundled inside the installer** at a pinned version — the
installer downloads nothing at install time, so installation works on a network
where GitHub is unreachable. The pinned version and a link to its corresponding
source are in [`third-party/sing-box/`](third-party/sing-box/).

Every MagicProxy binary is built in public GitHub Actions CI from the tagged commit,
with build provenance attested via Sigstore. Verify a download:

```powershell
Get-FileHash .\MagicProxy-Setup.exe -Algorithm SHA256
```

Compare against `SHA256SUMS.txt` in the release. With the GitHub CLI you can also
verify provenance cryptographically:

```
gh attestation verify MagicProxy-Setup.exe --repo MagicMaxLabs/MagicProxy
```

**The installer is not code-signed.** Windows SmartScreen will warn on it. Code
signing is not currently available to this project, so verify the hash instead — the
full source and the exact build workflow are public, and anyone can rebuild and
compare.

Antivirus engines regularly flag proxy tools written in Go as false positives. If
yours objects, the source and the CI build log for that exact binary are public.

---

## Scope

**In scope:** the browser extension, the native messaging host, the installer, and
the core configuration MagicProxy generates.

**Out of scope:** vulnerabilities in sing-box itself (report those upstream), and the
security or trustworthiness of the proxy server you choose to connect to.
