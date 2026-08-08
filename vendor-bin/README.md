# vendor-bin

Runtime binaries live here (git-ignored). After building/downloading you should have:

```
vendor-bin/
  magicproxy-host.exe   # built from native-host/ (go build)
  sing-box.exe          # downloaded from https://github.com/SagerNet/sing-box/releases
```

Download the Windows amd64 `sing-box` archive, extract `sing-box.exe`, and drop it
here. Then run `setup.ps1` from the repository root to register the native host,
or build the installer from `installer/magicproxy.iss`.

`build.ps1` produces `magicproxy-host.exe` from `native-host/`.
