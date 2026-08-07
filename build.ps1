<#
.SYNOPSIS
  Builds the MagicProxy native host.

.DESCRIPTION
  Icons are committed artwork in extension/assets — there is nothing to generate.
  This script only builds the Go host; setup.ps1 handles the sing-box core and the
  native-messaging registration.
#>
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
  go build -o $out ./cmd/host
  Write-Host "Built magicproxy-host.exe"
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "Next:"
Write-Host "  1. .\setup.bat   (fetches the pinned sing-box core, registers the native host)"
Write-Host "  2. Load extension\ unpacked at brave://extensions (Developer mode)"
