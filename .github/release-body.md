---

### Install

1. Download **MagicProxy-Setup.exe** below and run it. Everything is included —
   nothing else to download, no versions to check.
2. Add the extension to your browser from the Chrome Web Store (link in the README).
3. Open the extension, paste your server link, switch it on.

The installer needs no administrator rights and installs only for your user account.

### Verify your download

```powershell
Get-FileHash .\MagicProxy-Setup.exe -Algorithm SHA256
```

Compare the result with `SHA256SUMS.txt` in this release.

Every binary is built in public GitHub Actions CI from the tagged commit and signed
with build provenance. If you have the GitHub CLI:

```
gh attestation verify MagicProxy-Setup.exe --repo MagicMaxLabs/MagicProxy
```

### Windows SmartScreen

The installer is not code-signed, so Windows may show "Windows protected your PC".
Click **More info → Run anyway**, or verify the SHA-256 above first. Code signing is
not currently available to this project; the full source and the build workflow are
public, so anyone can rebuild and compare.

Antivirus engines sometimes flag proxy tools written in Go as a false positive. If
that happens, the source and build log for this exact binary are public.

### Third-party components

This release bundles [sing-box](https://github.com/SagerNet/sing-box) (GPL-3.0-or-later,
Copyright © 2022 nekohasekai) as its networking core. The complete corresponding source
for the exact bundled version is linked in `third-party/sing-box/README.md`, included in
the download. MagicProxy is not affiliated with sing-box or SagerNet.
