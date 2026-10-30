Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$AppRoot = Split-Path -Parent $PSScriptRoot
$AppFile = Join-Path $AppRoot "app.py"
$Port = 43127

function Test-HandbookServer {
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/profiles" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

function Find-Python {
    $pyLauncher = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($pyLauncher) {
        try {
            & $pyLauncher.Source -3.12 --version *> $null
            if ($LASTEXITCODE -eq 0) { return @($pyLauncher.Source, "-3.12") }
        } catch { }
        try {
            & $pyLauncher.Source -3 --version *> $null
            if ($LASTEXITCODE -eq 0) { return @($pyLauncher.Source, "-3") }
        } catch { }
    }

    $python = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($python) { return @($python.Source) }

    $roots = @(
        (Join-Path $env:LOCALAPPDATA "Programs\Python"),
        (Join-Path $env:ProgramFiles "Python"),
        (Join-Path ${env:ProgramFiles(x86)} "Python")
    ) | Where-Object { $_ -and (Test-Path $_) }
    foreach ($root in $roots) {
        $candidate = Get-ChildItem -Path $root -Recurse -Filter python.exe -File -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending | Select-Object -First 1
        if ($candidate) { return @($candidate.FullName) }
    }
    return $null
}

if (Test-HandbookServer) {
    Write-Host "Anime Handbook is already running." -ForegroundColor Green
    exit 0
}

$pythonCommand = Find-Python
if (-not $pythonCommand) {
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if (-not $winget) {
        throw "Python is required. Install Python 3.12 from python.org, then run this file again."
    }
    Write-Host "Installing Python 3.12 for Anime Handbook..." -ForegroundColor Cyan
    & $winget.Source install --id Python.Python.3.12 --exact --accept-package-agreements --accept-source-agreements --silent
    if ($LASTEXITCODE -ne 0) { throw "Python installation failed (winget exit code $LASTEXITCODE)." }
    $pythonCommand = Find-Python
    if (-not $pythonCommand) {
        throw "Python was installed but cannot be found yet. Close this window and run the start file once more."
    }
}

$pythonPath = $pythonCommand[0]
$pythonArguments = '"{0}" --no-browser' -f $AppFile
if ($pythonCommand.Count -gt 1) { $pythonArguments = "$($pythonCommand[1]) $pythonArguments" }

Start-Process -FilePath $pythonPath -ArgumentList $pythonArguments -WorkingDirectory $AppRoot -WindowStyle Hidden
$deadline = (Get-Date).AddSeconds(25)
do {
    Start-Sleep -Milliseconds 500
} while (-not (Test-HandbookServer) -and (Get-Date) -lt $deadline)

if (-not (Test-HandbookServer)) {
    throw "The server did not answer on http://127.0.0.1:$Port."
}
Write-Host "Anime Handbook started." -ForegroundColor Green
