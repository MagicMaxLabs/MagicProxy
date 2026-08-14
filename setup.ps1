<#
.SYNOPSIS
  One-click setup for MagicProxy. No arguments needed.

.DESCRIPTION
  Because the extension ships the Chrome Web Store's public key in its manifest,
  its ID is constant ("gpkpglcfdlodjbabgjackonmfpemaomg") for both the store build
  and a build from source, so this script needs no user input:

    1. Ensures binaries exist (builds the host if Go is present; downloads
       sing-box automatically if missing).
    2. Writes the native-messaging manifest next to the host exe (relative path,
       so the whole folder stays portable).
    3. Registers the host under the registry key of every Chromium browser found.

  Run by double-clicking setup.bat, or:  powershell -ExecutionPolicy Bypass -File setup.ps1

.PARAMETER Uninstall
  Remove the registration and generated manifest.
#>
param([switch]$Uninstall)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# --- Fixed identity ---------------------------------------------------------
# The ID comes from the "key" field in extension/manifest.json, which holds the
# public key the Chrome Web Store issued for this item. Because the same key is
# committed to the repo, a build from source and the Web Store build share this
# ID, so a single allowed_origins entry covers both.
# Add more IDs here (Edge Add-ons issues its own) — wildcards are not permitted.
$HostName     = "com.magicproxy.host"
$ExtensionIds = @("gpkpglcfdlodjbabgjackonmfpemaomg")

$Root      = $PSScriptRoot
$Bin       = Join-Path $Root "vendor-bin"
$HostExe   = Join-Path $Bin "magicproxy-host.exe"
$SingBox   = Join-Path $Bin "sing-box.exe"
$Manifest  = Join-Path $Bin "$HostName.json"

# All Chromium NativeMessagingHosts registry locations (HKCU).
$BrowserKeys = [ordered]@{
  Brave    = "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$HostName"
  Chrome   = "Software\Google\Chrome\NativeMessagingHosts\$HostName"
  Edge     = "Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
  Chromium = "Software\Chromium\NativeMessagingHosts\$HostName"
  Vivaldi  = "Software\Vivaldi\NativeMessagingHosts\$HostName"
}

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# ---------------------------------------------------------------------------
if ($Uninstall) {
  foreach ($name in $BrowserKeys.Keys) {
    $key = "HKCU:\" + $BrowserKeys[$name]
    if (Test-Path $key) { Remove-Item $key -Force; Write-Host "  removed $name" }
  }
  if (Test-Path $Manifest) { Remove-Item $Manifest -Force }
  # Сгенерированный конфиг ядра содержит адрес сервера и пароли открытым текстом.
  # Хост убирает его сам при каждом штатном выходе, но после аварийного завершения
  # файл остаётся — а PRIVACY.md обещает, что деинсталляция его удаляет.
  $tmpDir = Join-Path $env:TEMP "magicproxy"
  if (Test-Path $tmpDir) { Remove-Item -Recurse -Force $tmpDir; Write-Host "  removed temp configs" }
  Write-Host "MagicProxy unregistered." -ForegroundColor Green
  return
}

New-Item -ItemType Directory -Force -Path $Bin | Out-Null

# --- 1a. Host binary --------------------------------------------------------
if (-not (Test-Path $HostExe)) {
  Write-Step "magicproxy-host.exe missing"
  $go = Get-Command go -ErrorAction SilentlyContinue
  if (-not $go) {
    $goCandidate = "C:\Users\$env:USERNAME\golang\go\bin\go.exe"
    if (Test-Path $goCandidate) { $go = @{ Source = $goCandidate } }
  }
  if ($go) {
    Write-Host "  building with Go..."
    Push-Location (Join-Path $Root "native-host")
    # -trimpath — как в CI и build.ps1: иначе в бинарник попадают локальные пути.
    try { & $go.Source build -trimpath -o $HostExe ./cmd/host } finally { Pop-Location }
  } else {
    throw "Host binary not found and Go is not installed. Either install Go 1.22+ and re-run, or download a prebuilt release from GitHub."
  }
} else {
  Write-Step "host binary present"
}

# --- 1b. sing-box core ------------------------------------------------------
# Released installers BUNDLE this binary, so this download only ever runs for a
# build from source. The version is pinned to third-party/sing-box/VERSION so a
# source build ships exactly what the release ships — and so the GPL source offer
# in third-party/sing-box/README.md stays truthful.
if (-not (Test-Path $SingBox)) {
  $pin = (Get-Content (Join-Path $Root "third-party\sing-box\VERSION") -Raw).Trim()
  Write-Step "downloading sing-box core $pin..."
  $headers = @{ "User-Agent" = "MagicProxy-Setup" }
  $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/SagerNet/sing-box/releases/tags/$pin" -Headers $headers -UseBasicParsing
  $asset = $rel.assets | Where-Object { $_.name -match "windows-amd64\.zip$" -and $_.name -notmatch "legacy" } | Select-Object -First 1
  if (-not $asset) { throw "No windows-amd64 asset published for sing-box $pin" }
  $zip = Join-Path $env:TEMP $asset.name
  $tmp = Join-Path $env:TEMP "magicproxy-singbox"
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing -Headers $headers
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $exe = Get-ChildItem -Path $tmp -Recurse -Filter "sing-box.exe" | Select-Object -First 1
  Copy-Item $exe.FullName -Destination $SingBox -Force
  Remove-Item -Recurse -Force $tmp
  Write-Host "  installed $pin"
} else {
  Write-Step "sing-box core present"
}

# --- 2. Native messaging manifest (relative path => portable folder) --------
Write-Step "writing native-messaging manifest"
$origins = ($ExtensionIds | ForEach-Object { "    `"chrome-extension://$_/`"" }) -join ",`r`n"
$manifestJson = @"
{
  "name": "$HostName",
  "description": "MagicProxy native messaging host",
  "path": "magicproxy-host.exe",
  "type": "stdio",
  "allowed_origins": [
$origins
  ]
}
"@
Set-Content -Path $Manifest -Value $manifestJson -Encoding UTF8

# --- 3. Register per browser ------------------------------------------------
Write-Step "registering with Chromium browsers"
foreach ($name in $BrowserKeys.Keys) {
  $key = "HKCU:\" + $BrowserKeys[$name]
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty -Path $key -Name "(default)" -Value $Manifest
  Write-Host "  registered $name"
}

Write-Host ""
Write-Host "MagicProxy is set up." -ForegroundColor Green
Write-Host "Allowed extension IDs: $($ExtensionIds -join ', ')"
Write-Host ""
Write-Host "If you haven't yet: open brave://extensions -> Developer mode ->" -ForegroundColor Yellow
Write-Host "Load unpacked -> select the 'extension' folder. Then reload it." -ForegroundColor Yellow
