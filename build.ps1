<#
.SYNOPSIS
  Builds the MagicProxy native host.

.DESCRIPTION
  Icons are committed artwork in extension/assets — there is nothing to generate.
  This script only builds the Go host; setup.ps1 handles the sing-box core and the
  native-messaging registration.
#>
param(
  # Версия, зашиваемая в бинарник (-ldflags -X main.hostVersion). Чтобы получить
  # побайтовое совпадение с релизом vX.Y.Z, передайте ту же версию:
  #   .\build.ps1 -Version 0.2.0
  # Без параметра собирается dev-сборка, и сравнивать её с релизом бессмысленно.
  [string]$Version = ""
)
$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot

if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
  throw "Go toolchain not found. Install Go 1.22+ from https://go.dev/dl/ (or 'winget install GoLang.Go'), then re-run."
}

$VendorBin = Join-Path $Root "vendor-bin"
New-Item -ItemType Directory -Force -Path $VendorBin | Out-Null

Push-Location (Join-Path $Root "native-host")
try {
  $out = Join-Path $VendorBin "magicproxy-host.exe"
  Write-Host "Building host -> $out"
  # -trimpath — то же, чем собирает CI. Без него в бинарник попадают абсолютные пути
  # того, кто собирал, и сборка из исходников перестаёт побайтово совпадать с
  # релизной. А «собери сам и сравни» — единственная замена отсутствующей подписи
  # кода, ломать её на пустом месте нельзя. Для точного совпадения нужен ещё и
  # тот же номер версии — см. параметр -Version выше.
  if ($Version) {
    go build -trimpath -ldflags "-X main.hostVersion=$Version" -o $out ./cmd/host
  } else {
    go build -trimpath -o $out ./cmd/host
  }
  Write-Host "Built magicproxy-host.exe"
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "Next:"
Write-Host "  1. .\setup.bat   (fetches the pinned sing-box core, registers the native host)"
Write-Host "  2. Load extension\ unpacked at brave://extensions (Developer mode)"
