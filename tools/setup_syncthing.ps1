param(
    [string]$SharedFolder = "",
    [string]$OwnerDeviceId = "",
    [string]$DeviceName = $env:COMPUTERNAME,
    [switch]$OwnerMode
)

# This file intentionally contains ASCII only. Windows PowerShell 5.1 reads
# UTF-8 files without a BOM as the system code page, which can corrupt Chinese
# strings and make the setup script fail before it even starts.
$ErrorActionPreference = "Stop"

$AppRoot = Split-Path -Parent $PSScriptRoot
$DataRoot = Join-Path $AppRoot "data"
$RequestRoot = Join-Path $DataRoot "sharing-request"
$HomeRoot = Join-Path $DataRoot "syncthing"
$LogPath = Join-Path $HomeRoot "syncthing.log"
$DefaultSharedFolder = Join-Path $AppRoot "shared"

function Find-Syncthing {
    $command = Get-Command syncthing -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }

    $wingetPackages = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
    if (Test-Path $wingetPackages) {
        $wingetFile = Get-ChildItem -Path $wingetPackages -Recurse -Filter "syncthing.exe" -File -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match "Syncthing\.Syncthing" } |
            Select-Object -First 1
        if ($wingetFile) { return $wingetFile.FullName }
    }

    $knownPaths = @(
        (Join-Path $env:ProgramFiles "Syncthing\syncthing.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Syncthing\syncthing.exe")
    )
    foreach ($path in $knownPaths) {
        if ($path -and (Test-Path $path)) { return $path }
    }
    return $null
}

function Wait-ForSyncthingBinary {
    param([int]$Seconds = 30)
    $deadline = (Get-Date).AddSeconds($Seconds)
    do {
        $binary = Find-Syncthing
        if ($binary) { return $binary }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    return $null
}

function Get-OwnSyncthingProcess {
    $needle = [regex]::Escape($HomeRoot)
    return Get-CimInstance Win32_Process -Filter "Name = 'syncthing.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match $needle } |
        Select-Object -First 1
}

function Test-SyncthingGui {
    param([string]$Url)
    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
    } catch {
        return $false
    }
}

function Add-OwnerDevice {
    param(
        [string]$SyncthingPath,
        [string]$OwnerId
    )
    if (-not $OwnerId) { return }
    $knownIds = @(& $SyncthingPath "--home=$HomeRoot" cli config devices list 2>$null)
    if ($knownIds -contains $OwnerId) { return }

    # The owner must exist in both Syncthing configurations before an incoming
    # shared folder can be announced. This makes the friend setup self-contained
    # instead of merely recording the owner's ID in a text file.
    & $SyncthingPath "--home=$HomeRoot" cli config devices add `
        "--device-id=$OwnerId" `
        "--name=Anime Handbook Owner" `
        "--addresses=dynamic" `
        "--compression=metadata"
    if ($LASTEXITCODE -ne 0) {
        throw "Syncthing could not add the owner device."
    }
}

function Ensure-SharedFolder {
    param(
        [string]$SyncthingPath,
        [string]$FolderPath,
        [string]$OwnerId
    )

    # Configure the folder on a friend's machine before the owner shares it.
    # This avoids the error-prone manual "accept folder" dialog and, crucially,
    # stores a normal Windows path rather than a path containing literal quotes.
    $folderId = "anime-handbook-share"
    $knownFolders = @(& $SyncthingPath "--home=$HomeRoot" cli config folders list 2>$null)
    if ($knownFolders -contains $folderId) {
        & $SyncthingPath "--home=$HomeRoot" cli config folders $folderId path set $FolderPath
    } else {
        & $SyncthingPath "--home=$HomeRoot" cli config folders add `
            "--id=$folderId" `
            "--label=Anime Handbook Share" `
            "--path=$FolderPath" `
            "--type=sendreceive"
    }
    if ($LASTEXITCODE -ne 0) {
        throw "Syncthing could not configure the handbook shared folder."
    }

    $sharedDevices = @(& $SyncthingPath "--home=$HomeRoot" cli config folders $folderId devices list 2>$null)
    if ($OwnerId -and -not ($sharedDevices -contains $OwnerId)) {
        & $SyncthingPath "--home=$HomeRoot" cli config folders $folderId devices add "--device-id=$OwnerId"
        if ($LASTEXITCODE -ne 0) {
            throw "Syncthing could not share the handbook folder with the owner device."
        }
    }
}

function Get-GuiUrl {
    $configPath = Join-Path $HomeRoot "config.xml"
    if (-not (Test-Path $configPath)) { return "http://127.0.0.1:8384" }
    $config = Get-Content -LiteralPath $configPath -Raw
    $match = [regex]::Match($config, '<gui[^>]*>\s*<address>([^<]+)</address>', [System.Text.RegularExpressions.RegexOptions]::Singleline)
    if (-not $match.Success) { return "http://127.0.0.1:8384" }
    $address = $match.Groups[1].Value.Trim()
    if ($address -match '^https?://') { return $address }
    return "http://$address"
}

function Install-LoginAutostart {
    param([string]$SyncthingPath)
    $arguments = 'serve --no-browser --no-console --home="{0}" --log-file="{1}"' -f $HomeRoot, $LogPath
    $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
    $command = '"{0}" {1}' -f $SyncthingPath, $arguments
    New-Item -Path $runKey -Force | Out-Null
    Set-ItemProperty -Path $runKey -Name "AnimeHandbookSyncthing" -Value $command -Type String
}

if (-not $SharedFolder) {
    $enteredFolder = Read-Host "Local shared folder (press Enter for $DefaultSharedFolder)"
    $SharedFolder = if ($enteredFolder) { $enteredFolder.Trim() } else { $DefaultSharedFolder }
}
if (-not $OwnerMode -and -not $OwnerDeviceId) {
    $OwnerDeviceId = Read-Host "Owner Syncthing Device ID (owner may press Enter)"
}

$syncthing = Find-Syncthing
if (-not $syncthing) {
    Write-Host "Installing Syncthing..." -ForegroundColor Cyan
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) {
        throw "winget was not found. Install App Installer, then run this script again."
    }
    & $winget.Source install --id Syncthing.Syncthing --exact --accept-package-agreements --accept-source-agreements --silent
    if ($LASTEXITCODE -ne 0) {
        throw "Syncthing installation failed (winget exit code $LASTEXITCODE)."
    }
    $syncthing = Wait-ForSyncthingBinary
    if (-not $syncthing) {
        throw "Syncthing was installed but syncthing.exe could not be found after 30 seconds. Close this window and run the script again."
    }
}

New-Item -ItemType Directory -Force -Path $HomeRoot, $RequestRoot, $SharedFolder | Out-Null

# Generate the dedicated handbook configuration before reading the ID. This is
# deterministic and does not depend on how quickly the background server starts.
$configPath = Join-Path $HomeRoot "config.xml"
if (-not (Test-Path $configPath)) {
    & $syncthing generate --home="$HomeRoot"
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $configPath)) {
        throw "Syncthing could not create its handbook configuration."
    }
}

$deviceId = (& $syncthing device-id --home="$HomeRoot" 2>$null | Select-Object -First 1).Trim()
if (-not $deviceId) {
    throw "Syncthing configuration exists but its device ID could not be read."
}

# Do not rely on querying another process's command line here: it may be
# unavailable on some Windows installations. Instead, verify the dedicated
# GUI directly. Start-Process joins an argument array without quoting paths,
# so use one explicitly quoted argument string for folders with spaces.
$guiUrl = Get-GuiUrl
if (-not (Test-SyncthingGui -Url $guiUrl)) {
    $arguments = 'serve --no-browser --no-console --home="{0}" --log-file="{1}"' -f $HomeRoot, $LogPath
    $startedProcess = Start-Process -FilePath $syncthing -ArgumentList $arguments -WindowStyle Hidden -PassThru
    $deadline = (Get-Date).AddSeconds(30)
    do {
        Start-Sleep -Milliseconds 750
    } while (-not (Test-SyncthingGui -Url $guiUrl) -and (Get-Date) -lt $deadline)
    if (-not (Test-SyncthingGui -Url $guiUrl)) {
        $exitHint = ""
        if ($startedProcess.HasExited) { $exitHint = " (process exit code $($startedProcess.ExitCode))" }
        throw "Syncthing did not start$exitHint. See log: $LogPath"
    }
}

if (-not $OwnerMode -and $OwnerDeviceId) {
    Add-OwnerDevice -SyncthingPath $syncthing -OwnerId $OwnerDeviceId
    Ensure-SharedFolder -SyncthingPath $syncthing -FolderPath $SharedFolder -OwnerId $OwnerDeviceId
}

try {
    Install-LoginAutostart -SyncthingPath $syncthing
    $autostartMessage = "Enabled (starts after Windows sign-in)"
} catch {
    $autostartMessage = "Could not create login task: $($_.Exception.Message)"
}

$request = [ordered]@{
    device_id = $deviceId
    device_name = if ($DeviceName) { $DeviceName } else { "friend-pc" }
    owner_device_id = $OwnerDeviceId
    requested_at = (Get-Date).ToUniversalTime().ToString("o")
    shared_folder = $SharedFolder
    app_root = $AppRoot
}
$requestPath = Join-Path $RequestRoot "device-request.json"
$request | ConvertTo-Json | Set-Content -Path $requestPath -Encoding UTF8

$infoPath = Join-Path $RequestRoot "device-info.txt"
@(
    "My Syncthing Device ID: $deviceId"
    "Local shared folder: $SharedFolder"
    "Owner Device ID: $OwnerDeviceId"
    "Device request file: $requestPath"
    "Syncthing UI: $guiUrl"
    "Login autostart: $autostartMessage"
    "Log file: $LogPath"
) | Set-Content -Path $infoPath -Encoding UTF8

Write-Host "Syncthing is ready." -ForegroundColor Green
Write-Host "Device ID: $deviceId"
Write-Host "Info file: $infoPath"
Write-Host "Request file: $requestPath"
Write-Host "Syncthing UI: $guiUrl"
Write-Host "Login autostart: $autostartMessage"
