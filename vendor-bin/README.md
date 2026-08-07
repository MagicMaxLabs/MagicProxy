# vendor-bin

Runtime binaries live here (git-ignored). After building/downloading you should have:

```
vendor-bin/
  magicproxy-host.exe   # built from native-host/ (go build)
  sing-box.exe          # downloaded from https://github.com/SagerNet/sing-box/releases
```

Download the Windows amd64 `sing-box` archive, extract `sing-box.exe`, and drop it
here. Then run `installer/install.ps1`.
