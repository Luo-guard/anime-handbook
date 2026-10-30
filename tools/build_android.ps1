param(
    [string]$JavaHome = $env:JAVA_HOME,
    [string]$Gradle = 'gradle',
    [switch]$Online
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$androidRoot = Join-Path $projectRoot 'android'
$outputRoot = Join-Path $projectRoot 'releases\android'
if (!(Test-Path -LiteralPath (Join-Path $JavaHome 'bin\java.exe'))) { throw 'Java 17 not found. Supply -JavaHome.' }
$gradleCommand = Get-Command $Gradle -ErrorAction SilentlyContinue
if ($gradleCommand) { $Gradle = $gradleCommand.Source }
if (!(Test-Path -LiteralPath $Gradle)) { throw 'Gradle not found. Install Gradle or supply -Gradle.' }
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$staging = [IO.Path]::GetFullPath((Join-Path $tempRoot ('AnimeHandbook-build-' + [guid]::NewGuid().ToString('N'))))
if ($staging -match '[^\x00-\x7F]') { throw 'Android tests require an ASCII temporary path. Set TEMP to an ASCII path.' }
if (!$staging.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid staging path.' }
$previousJavaHome = $env:JAVA_HOME
try {
    New-Item -ItemType Directory -Path (Join-Path $staging 'app') -Force | Out-Null
    foreach ($file in @('build.gradle', 'settings.gradle', 'gradle.properties', 'local.properties')) {
        Copy-Item -LiteralPath (Join-Path $androidRoot $file) -Destination $staging
    }
    Copy-Item -LiteralPath (Join-Path $androidRoot 'app\build.gradle') -Destination (Join-Path $staging 'app')
    Copy-Item -LiteralPath (Join-Path $androidRoot 'app\src') -Destination (Join-Path $staging 'app') -Recurse
    $env:JAVA_HOME = $JavaHome
    $arguments = @('-p', $staging, ':app:testDebugUnitTest', ':app:assembleDebug', '--console=plain', '--no-daemon')
    if (!$Online) { $arguments += '--offline' }
    & $Gradle @arguments
    if ($LASTEXITCODE -ne 0) { throw 'Android tests or build failed. No APK was published.' }
    $metadata = Get-Content -LiteralPath (Join-Path $staging 'app\build\outputs\apk\debug\output-metadata.json') -Raw | ConvertFrom-Json
    $version = [string]$metadata.elements[0].versionName
    if ($version -notmatch '^\d+(\.\d+)*$') { throw 'Unexpected APK version.' }
    New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
    $destination = Join-Path $outputRoot ('anime-handbook-v' + $version + '-debug.apk')
    # Use the same signing keystore as earlier local builds.
    Copy-Item -LiteralPath (Join-Path $staging 'app\build\outputs\apk\debug\app-debug.apk') -Destination $destination -Force
    Write-Host "APK: $destination"
} finally {
    $env:JAVA_HOME = $previousJavaHome
    # Delete only this invocation's GUID-named temporary build directory.
    $resolved = [IO.Path]::GetFullPath($staging)
    if ($resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($resolved) -match '^AnimeHandbook-build-[a-f0-9]{32}$' -and
        (Test-Path -LiteralPath $resolved)) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
