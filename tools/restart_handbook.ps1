# Restart the Anime Handbook backend: shut the old process down gracefully, then let
# launch_handbook.ps1 start a detached one.
#
# Why this exists:
#   Running `python app.py --no-browser` in the foreground keeps the service inside a
#   background task, so the task panel shows "1 background task running" forever and it
#   looks like a zombie (it is actually the server itself). This script closes the old
#   process through /api/desktop/shutdown and restarts it via Start-Process, so the
#   service keeps running without leaving a background task behind.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tools\restart_handbook.ps1
#
# Run this from your own terminal (or a .cmd you double-click). Measured limitation: when
# an automation/tool session calls it, the process it starts may be reaped together with
# that session (children are wrapped in a job object), so the server would stop shortly
# after the tool returns. Starting it from your own session is what keeps it alive.
#
# Keep this file ASCII-only: Windows PowerShell 5.1 reads .ps1 as ANSI and would mangle
# non-ASCII comments into parse errors.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
# Do not print Invoke-WebRequest progress bars; they flood the console.
$ProgressPreference = "SilentlyContinue"

$Port = 43127
$Base = "http://127.0.0.1:$Port"

function Test-Server {
    try {
        $response = Invoke-WebRequest -Uri "$Base/api/profiles" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

if (Test-Server) {
    $health = Invoke-RestMethod -Uri "$Base/api/health" -TimeoutSec 5
    $token = $health.shutdown_token
    if (-not $token) { throw "No shutdown_token from /api/health; refusing to continue." }

    $headers = @{
        "X-Handbook-Shutdown" = $token
        "Origin"              = $Base
    }

    # 409 means the server is syncing data and will not close; retry every 2s for 20s.
    $deadline = (Get-Date).AddSeconds(20)
    $accepted = $false
    while ((Get-Date) -lt $deadline) {
        try {
            Invoke-RestMethod -Uri "$Base/api/desktop/shutdown" -Method Post -Headers $headers -TimeoutSec 5 | Out-Null
            $accepted = $true
            break
        } catch {
            Start-Sleep -Seconds 2
        }
    }
    if (-not $accepted) {
        throw "The old backend refused to shut down (probably syncing). Nothing was restarted."
    }

    # Wait until the port is really free before starting the new process.
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline -and (Test-Server)) { Start-Sleep -Milliseconds 400 }
    Write-Host "Old backend stopped." -ForegroundColor DarkGray
} else {
    Write-Host "Backend was not running; starting a fresh one." -ForegroundColor DarkGray
}

& (Join-Path $PSScriptRoot "launch_handbook.ps1")

if (Test-Server) {
    Write-Host "Backend ready at $Base (detached process, no background task)." -ForegroundColor Green
} else {
    throw "Launcher reported success but $Base still does not answer."
}
