#Requires -Version 5
# Run once on a fresh Windows 11 machine to install everything Every Ear needs.
# Equivalent of scripts/install-mac.sh.

$ErrorActionPreference = "Stop"
Set-Location "$PSScriptRoot\.."

function Refresh-Path {
  $machine = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
  $user    = [System.Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = ($machine, $user, $env:Path) -join ";"
}

# ---- Package manager check -------------------------------------------------

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  Write-Error @"
winget not found. Install 'App Installer' from the Microsoft Store first
(or update Windows 11 — App Installer ships built-in).
"@
  exit 1
}

# ---- Tooling ---------------------------------------------------------------

Write-Host "→ Installing Node.js LTS via winget…" -ForegroundColor Cyan
winget install --silent --accept-source-agreements --accept-package-agreements `
  --id "OpenJS.NodeJS.LTS" -e | Out-Host

Write-Host "→ Installing Caddy via winget…" -ForegroundColor Cyan
winget install --silent --accept-source-agreements --accept-package-agreements `
  --id "CaddyServer.Caddy" -e | Out-Host

Refresh-Path

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node was installed but isn't on PATH yet. Open a new PowerShell window and re-run this script."
  exit 1
}

# ---- LiveKit server (download manually — not on winget) -------------------

# Tag includes the "v"; the release asset filename does not.
$lkVersion    = "v1.11.0"
$lkVersionNoV = $lkVersion.TrimStart('v')
$lkZipName    = "livekit_${lkVersionNoV}_windows_amd64.zip"
$lkUrl        = "https://github.com/livekit/livekit/releases/download/$lkVersion/$lkZipName"
$binDir       = Join-Path $PWD ".bin"
$lkExe        = Join-Path $binDir "livekit-server.exe"

if (-not (Test-Path $lkExe)) {
  Write-Host "→ Downloading LiveKit server $lkVersion…" -ForegroundColor Cyan
  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  $tmpZip = Join-Path $env:TEMP $lkZipName
  Invoke-WebRequest -Uri $lkUrl -OutFile $tmpZip -UseBasicParsing
  Expand-Archive -Path $tmpZip -DestinationPath $binDir -Force
  Remove-Item $tmpZip
}
Write-Host "→ LiveKit server ready at $lkExe" -ForegroundColor Cyan

# ---- .env ------------------------------------------------------------------

if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"

  $candidates = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.PrefixOrigin -in 'Dhcp','Manual' -and
      $_.IPAddress -notlike '127.*' -and
      $_.IPAddress -notlike '169.254.*'
    } |
    Sort-Object -Property InterfaceMetric

  $lan = "127.0.0.1"
  if ($candidates) { $lan = $candidates[0].IPAddress }

  (Get-Content .env) `
    -replace '^LIVEKIT_NODE_IP=.*', "LIVEKIT_NODE_IP=$lan" `
    -replace '^PUBLIC_HOST=.*',     "PUBLIC_HOST=$lan" |
    Set-Content .env -Encoding UTF8

  Write-Host "→ Wrote .env (LAN IP detected: $lan). Edit ADMIN_PASSWORD before going live." -ForegroundColor Cyan
}

# ---- npm dependencies ------------------------------------------------------

Write-Host "→ Installing root, backend and frontend dependencies…" -ForegroundColor Cyan
npm install                       | Out-Host
npm install --prefix backend      | Out-Host
npm install --prefix frontend     | Out-Host

# ---- URL ACL + firewall (needs admin) -------------------------------------

$elevatedScript = @'
$ErrorActionPreference = "Continue"
$me = "$env:USERDOMAIN\$env:USERNAME"
Write-Host "Reserving https://+:443/ for $me…" -ForegroundColor Cyan
netsh http add urlacl url=https://+:443/ user="$me" | Out-Host

Write-Host "Adding firewall rule: Every Ear HTTPS (TCP/443)…" -ForegroundColor Cyan
netsh advfirewall firewall add rule name="Every Ear HTTPS" dir=in action=allow protocol=TCP localport=443 | Out-Host

Write-Host "Adding firewall rule: Every Ear LiveKit TCP/7881…" -ForegroundColor Cyan
netsh advfirewall firewall add rule name="Every Ear LiveKit TCP" dir=in action=allow protocol=TCP localport=7881 | Out-Host

Write-Host "Adding firewall rule: Every Ear LiveKit UDP/7882…" -ForegroundColor Cyan
netsh advfirewall firewall add rule name="Every Ear LiveKit UDP" dir=in action=allow protocol=UDP localport=7882 | Out-Host

Write-Host ""
Write-Host "Elevated setup done. You can close this window." -ForegroundColor Green
Start-Sleep -Seconds 2
'@

$tmpScript = Join-Path $env:TEMP "every-ear-elevated.ps1"
Set-Content -Path $tmpScript -Value $elevatedScript -Encoding UTF8

Write-Host "→ Granting Caddy permission to bind :443 and opening firewall ports (UAC prompt)…" -ForegroundColor Cyan
Start-Process -FilePath "powershell.exe" `
  -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File",$tmpScript `
  -Verb RunAs -Wait

Write-Host @"

✓ Setup done.

Next steps:
  1. Edit .env — set ADMIN_PASSWORD (and adjust languages if needed).
  2. Start everything:    .\scripts\start.cmd        (or .\scripts\start.ps1)
  3. Show listener URL:   .\scripts\show-url.cmd     (or .\scripts\show-url.ps1)

The first time you start, Windows may ask whether to allow incoming
connections for caddy.exe and livekit-server.exe. Click "Allow" both times.
"@ -ForegroundColor Green
