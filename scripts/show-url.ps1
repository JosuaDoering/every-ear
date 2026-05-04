#Requires -Version 5
# Print the listener URL and a QR code for it. Equivalent of scripts/show-url.sh.

$ErrorActionPreference = "Stop"
Set-Location "$PSScriptRoot\.."

if (-not (Test-Path ".env")) {
  Write-Error "No .env — run scripts\install-windows.ps1 first."
  exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js is not on PATH. Run scripts\install-windows.ps1 first."
  exit 1
}

& node scripts\show-url.mjs
exit $LASTEXITCODE
