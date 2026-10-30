param(
    [string]$Url = "http://127.0.0.1:43127",
    [int]$WaitSeconds = 8,
    [int]$DebugPort = 43128
)

# A normal browser window does not consistently expose individual tabs to
# Windows automation.  This launcher instead owns one local Edge profile and
# uses Edge's loopback DevTools endpoint to activate the exact handbook tab.

function Test-HandbookServer {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "$Url/api/health" -TimeoutSec 1
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

function Get-ManagedTabs {
    try {
        $payload = Invoke-RestMethod -Uri "http://127.0.0.1:$DebugPort/json/list" -TimeoutSec 1
        foreach ($item in $payload) {
            Write-Output $item
        }
    } catch {
        return
    }
}

function Activate-ManagedHandbookTab {
    $handbookUrl = "$Url/"
    $tabs = @(Get-ManagedTabs)
    foreach ($tab in $tabs) {
        $isPage = ([string]$tab.type) -eq "page"
        $isHandbookUrl = ([string]$tab.url).StartsWith(
            $handbookUrl,
            [System.StringComparison]::OrdinalIgnoreCase
        )
        if ((-not $isPage) -or (-not $isHandbookUrl)) {
            continue
        }
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$DebugPort/json/activate/$($tab.id)" -TimeoutSec 2
            return $response.StatusCode -eq 200
        } catch {
            return $false
        }
    }
    return $false
}

function Find-EdgeExecutable {
    $command = Get-Command msedge.exe -ErrorAction SilentlyContinue
    $paths = @(
        $command.Source,
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
    )
    foreach ($path in $paths) {
        if ($path -and (Test-Path -LiteralPath $path)) {
            return $path
        }
    }
    return $null
}

$deadline = (Get-Date).AddSeconds([Math]::Max(1, $WaitSeconds))
while ((Get-Date) -lt $deadline) {
    if (Test-HandbookServer) { break }
    Start-Sleep -Milliseconds 250
}

if (-not (Test-HandbookServer)) {
    exit 1
}

if (Activate-ManagedHandbookTab) {
    exit 0
}

$edge = Find-EdgeExecutable
if ($edge) {
    $profile = Join-Path (Split-Path -Parent $PSScriptRoot) "data\handbook-browser-profile"
    New-Item -ItemType Directory -Path $profile -Force | Out-Null
    $arguments = "--remote-debugging-address=127.0.0.1 --remote-debugging-port=$DebugPort --user-data-dir=`"$profile`" --new-window `"$Url`""
    Start-Process -FilePath $edge -ArgumentList $arguments
    exit 0
}

# Edge is unavailable: preserve a usable fallback in the system default browser.
Start-Process $Url
