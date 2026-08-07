<#
.SYNOPSIS
  Builds the MagicProxy native host and generates extension icons.
#>
$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot

# 1. Icons (needs Node)
if (Get-Command node -ErrorAction SilentlyContinue) {
  node (Join-Path $Root "extension/tools/generate-icons.mjs")
} else {
  Write-Warning "node not found — skipping icon generation."
}

# 2. Native host (needs Go)
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
Write-Host "  1. Put sing-box.exe into vendor-bin/ (https://github.com/SagerNet/sing-box/releases)"
Write-Host "  2. Load extension/ unpacked in brave://extensions, copy its Extension ID"
Write-Host "  3. installer/install.ps1 -ExtensionId <id>"
