<#
.SYNOPSIS
  Builds a Chrome Web Store-ready zip of the extension.

.DESCRIPTION
  Copies extension/ to a temp folder, drops dev-only tooling, removes the "key"
  field (CWS assigns its own ID), and zips the result. See docs/CHROME_WEB_STORE.md.
#>
$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$Src  = Join-Path $Root "extension"
$Out  = Join-Path $Root "MagicProxy-extension-store.zip"
$Tmp  = Join-Path $env:TEMP ("mp-store-" + [System.Guid]::NewGuid().ToString("N"))

New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
Copy-Item -Recurse "$Src\*" $Tmp

# Remove dev-only tooling (icon/key generators).
$tools = Join-Path $Tmp "tools"
if (Test-Path $tools) { Remove-Item -Recurse -Force $tools }

# Strip the "key" field: the Web Store assigns its own extension ID.
#
# -Encoding UTF8 is REQUIRED: Windows PowerShell 5.1's Get-Content defaults to the
# system ANSI codepage, so a UTF-8 manifest without a BOM is misread (an em dash
# becomes "вЂ") and then written back as UTF-8, permanently corrupting the store
# title — which cannot be edited in the dashboard.
$manifestPath = Join-Path $Tmp "manifest.json"
$manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.PSObject.Properties.Name -contains "key") {
  $manifest.PSObject.Properties.Remove("key")
}
# Write UTF-8 WITHOUT a BOM: Set-Content -Encoding UTF8 on Windows PowerShell 5.1
# always emits one, and a BOM at the start of manifest.json is a needless risk for
# a file every Chromium parser has to read.
$json = $manifest | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))

if (Test-Path $Out) { Remove-Item $Out -Force }

# Build the zip with forward-slash entry names — the Chrome Web Store rejects
# archives that use Windows backslash separators for nested paths.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($Out, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  Get-ChildItem -Recurse -File $Tmp | ForEach-Object {
    $rel = $_.FullName.Substring($Tmp.Length + 1) -replace '\\', '/'
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel) | Out-Null
  }
} finally {
  $zip.Dispose()
}
Remove-Item -Recurse -Force $Tmp

Write-Host "Store package: $Out" -ForegroundColor Green
Write-Host "Upload it at https://chrome.google.com/webstore/devconsole"
