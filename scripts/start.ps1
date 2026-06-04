#Requires -Version 5
# Start LiveKit + backend + frontend + Caddy on Windows.
# Equivalent of scripts/start.sh.

$ErrorActionPreference = "Stop"
Set-Location "$PSScriptRoot\.."

if (-not (Test-Path ".env")) {
  Write-Error "No .env — run scripts\install-windows.ps1 first."
  exit 1
}

# Make the LiveKit binary that the installer dropped into .\.bin discoverable.
$binDir = Join-Path $PWD ".bin"
if (Test-Path $binDir) {
  $env:Path = "$binDir;$env:Path"
}

# Keep the system + display awake while the orchestrator is running.
# SetThreadExecutionState with ES_CONTINUOUS holds the request until this
# PowerShell process exits, at which point Windows resumes normal sleep behavior.
$signature = @"
using System;
using System.Runtime.InteropServices;
public class EveryEarPower {
  [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
  public static extern uint SetThreadExecutionState(uint esFlags);
}
"@
try {
  Add-Type -TypeDefinition $signature -Language CSharp -ErrorAction Stop
  $ES_CONTINUOUS       = [uint32]"0x80000000"
  $ES_SYSTEM_REQUIRED  = [uint32]"0x00000001"
  $ES_DISPLAY_REQUIRED = [uint32]"0x00000002"
  [EveryEarPower]::SetThreadExecutionState(
    $ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED -bor $ES_DISPLAY_REQUIRED
  ) | Out-Null
} catch {
  Write-Warning "Could not enable sleep prevention: $($_.Exception.Message)"
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js is not on PATH. Run scripts\install-windows.ps1 first (or open a fresh PowerShell window)."
  exit 1
}

# Hand off to the cross-platform orchestrator.
& node scripts\dev.mjs
exit $LASTEXITCODE
