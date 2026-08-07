# Contributing

## Build from source

Requirements: **Go 1.22+**, **Node.js 18+**, Windows 10/11.

```powershell
.\build.ps1     # builds vendor-bin\magicproxy-host.exe and the icons
.\setup.bat     # registers the native host and fetches the pinned sing-box core
```

Then load `extension\` as an unpacked extension at `brave://extensions`
(Developer mode → Load unpacked).

The `key` field committed in `extension/manifest.json` is the Chrome Web Store's
**public** key for this item, so a build from source gets the same extension ID as
the store build — which means the native host's `allowed_origins` already covers it
and no extra registration is needed.

## Before opening a pull request

```powershell
cd native-host; go vet ./...            # must be clean
```

If you touched protocol generation, validate every affected type against the real
core rather than by eye:

```powershell
vendor-bin\sing-box.exe check -c <generated-config.json>
```

**`check` validates syntax, not meaning.** It has passed configurations that the
core then refuses to start, and configurations that start but never connect. If
your change can affect runtime, actually run it:

```powershell
vendor-bin\sing-box.exe run -c <generated-config.json>
```

## House rules

- **Keep the extension unminified and dependency-free.** It ships to the Chrome Web
  Store as authored, and reviewers read it. No bundler, no npm dependencies in the
  extension.
- **Never widen permissions casually.** The extension requests four permissions and
  zero host permissions; that is a deliberate and defensible position.
- **Fail closed.** If the proxy cannot be guaranteed, the correct behaviour is to
  lose connectivity, never to fall back to a direct connection silently.
- **Never report success you have not verified.** A green "on" state that is not
  actually proxying is a safety bug in this product, not a cosmetic one.

## Scope

MagicProxy has one purpose: proxying a single browser profile. Features that touch
page content, block ads, manage cookies, or spoof user agents are out of scope —
they would also break the Chrome Web Store single-purpose requirement.

## Reporting bugs

Use the issue templates. Configuration and setup questions belong in Discussions,
not Issues. **Always redact your server address and credentials** before pasting
logs or profiles.
