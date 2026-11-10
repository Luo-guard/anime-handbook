param(
    [string]$Url = "http://localhost:43127",
    [int]$WaitSeconds = 8,
    [int]$DebugPort = 43128
)

# A normal browser window does not consistently expose individual tabs to
# Windows automation.  This launcher instead owns one local Edge profile and
# uses Edge's loopback DevTools endpoint to activate the exact handbook tab.

$script:HandbookProjectRoot = Split-Path -Parent $PSScriptRoot

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

function Get-BrowserProfilePath {
    # Chromium 的用户目录只是缓存和登录态，没有手账数据。留在 data/ 会让
    # 备份、迁移、共享都拖上近 2 GB 可再生文件，所以放到 %LOCALAPPDATA%。
    $root = if ($env:LOCALAPPDATA) {
        Join-Path $env:LOCALAPPDATA "AnimeHandbook"
    } else {
        Join-Path $env:USERPROFILE "AppData\Local\AnimeHandbook"
    }
    return Join-Path $root "browser-profile"
}

function Initialize-BrowserProfile {
    param([string]$Profile, [string]$Legacy)
    if ((-not (Test-Path -LiteralPath $Profile)) -and (Test-Path -LiteralPath $Legacy)) {
        Write-Host "首次启动：正在把浏览器配置迁移到 $Profile（只需一次，请稍候）"
        New-Item -ItemType Directory -Path (Split-Path -Parent $Profile) -Force | Out-Null
        # A failed copy must not leave a seemingly complete final profile.
        $staging = $Profile + ".migration-staging"
        $null = robocopy $Legacy $staging /E /COPY:DAT /R:1 /W:1 /MT:8 /NFL /NDL /NJH /NJS
        if ($LASTEXITCODE -ge 8) {
            Write-Host "迁移失败，继续使用原目录。"
            return $Legacy
        }
        # 留一个标记：等新目录真的能启动浏览器之后，再删旧目录。
        Set-Content -LiteralPath (Join-Path $staging ".migrated-from") -Value $Legacy -Encoding utf8
        Move-Item -LiteralPath $staging -Destination $Profile -ErrorAction Stop
    }
    New-Item -ItemType Directory -Path $Profile -Force | Out-Null
    return $Profile
}

function Test-BrowserProfileOwner {
    param([string]$Profile)
    try {
        $listeners = @(Get-NetTCPConnection -LocalPort $DebugPort -State Listen -ErrorAction Stop)
        foreach ($listener in $listeners) {
            $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction Stop
            $command = [string]$process.CommandLine
            if ($command -match '(?:^|\s)--user-data-dir=(?:"([^"]+)"|([^\s]+))(?=\s|$)') {
                $directory = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
                if ([IO.Path]::GetFullPath($directory).TrimEnd('\') -ieq [IO.Path]::GetFullPath($Profile).TrimEnd('\')) { return $true }
            }
        }
    } catch { }
    return $false
}

function Complete-BrowserProfileMigration {
    # DevTools 端点能在新 profile 上应答，才算“迁移后的目录可用”。
    # 只有这时才删旧目录，避免复制出错时连原来能用的配置一起丢了。
    param([string]$Profile)
    if (-not $Profile) { return }
    $marker = Join-Path $Profile ".migrated-from"
    if (-not (Test-Path -LiteralPath $marker)) { return }
    $legacy = ([string](Get-Content -LiteralPath $marker -Raw)).Trim()
    if (-not $legacy) { return }
    # The marker can only refer to the exact legacy directory, never a parent.
    $expected = [IO.Path]::GetFullPath((Join-Path $script:HandbookProjectRoot "data\handbook-browser-profile")).TrimEnd('\')
    try { $legacy = [IO.Path]::GetFullPath($legacy).TrimEnd('\') } catch { return }
    if ($legacy -ine $expected -or $legacy -ieq [IO.Path]::GetFullPath($Profile).TrimEnd('\')) { return }
    if (-not (Test-BrowserProfileOwner -Profile $Profile)) { return }
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline) {
        try {
            $null = Invoke-RestMethod -Uri "http://127.0.0.1:$DebugPort/json/version" -TimeoutSec 1
            if (-not (Test-BrowserProfileOwner -Profile $Profile)) { return }
            if (Test-Path -LiteralPath $legacy) {
                $entry = Get-Item -LiteralPath $legacy -Force
                if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { return }
                Remove-Item -LiteralPath $legacy -Recurse -Force -ErrorAction Stop
            }
            # 旧目录被占用时删除会失败；这时保留标记，下次启动再试。
            if (-not (Test-Path -LiteralPath $legacy)) {
                Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
            }
            return
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
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
    $legacyProfile = Join-Path (Split-Path -Parent $PSScriptRoot) "data\handbook-browser-profile"
    $profile = Initialize-BrowserProfile -Profile (Get-BrowserProfilePath) -Legacy $legacyProfile
    $arguments = "--remote-debugging-address=127.0.0.1 --remote-debugging-port=$DebugPort --user-data-dir=`"$profile`" --new-window `"$Url`""
    Start-Process -FilePath $edge -ArgumentList $arguments
    Complete-BrowserProfileMigration -Profile $profile
    exit 0
}

# Edge is unavailable: preserve a usable fallback in the system default browser.
Start-Process $Url
