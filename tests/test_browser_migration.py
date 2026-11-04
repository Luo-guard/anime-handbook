"""Exercise launcher migration functions only, entirely inside a temp workspace."""
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


@unittest.skipUnless(os.name == "nt", "Windows launcher")
class BrowserMigrationTests(unittest.TestCase):
    def test_staging_retry_owner_and_marker_guards(self):
        source = Path("tools/activate_handbook_browser.ps1").resolve()
        self.assertTrue(source.read_bytes().startswith(b"\xef\xbb\xbf"))
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "tools").mkdir()
            script = root / "tools" / "check.ps1"
            body = r'''
$ErrorActionPreference = "Stop"
$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($args[0], [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw "Launcher parse error" }
$functions = $ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst]}, $false)
foreach ($definition in $functions) { Invoke-Expression $definition.Extent.Text }
function Assert-That { param($condition, $message) if (-not $condition) { throw $message } }
$fixtureRoot = Split-Path -Parent $PSScriptRoot
$script:HandbookProjectRoot = $fixtureRoot
$legacy = Join-Path $fixtureRoot "data\handbook-browser-profile"
$profile = Join-Path $fixtureRoot "new-profile"
New-Item -ItemType Directory -Path $legacy -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $legacy "Bookmarks"), "test bookmarks")
$script:copyFails = $true
function robocopy {
    param($sourcePath, $destinationPath)
    New-Item -ItemType Directory -Path $destinationPath -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $sourcePath "Bookmarks") -Destination $destinationPath
    $global:LASTEXITCODE = if ($script:copyFails) { 8 } else { 1 }
}
$selected = Initialize-BrowserProfile -Profile $profile -Legacy $legacy
Assert-That ($selected -eq $legacy) "failed copy must use legacy"
Assert-That (-not (Test-Path -LiteralPath $profile)) "partial final profile leaked"
$script:copyFails = $false
$selected = Initialize-BrowserProfile -Profile $profile -Legacy $legacy
Assert-That ($selected -eq $profile) "retry did not finish"
Assert-That ((Get-Content -LiteralPath (Join-Path $profile "Bookmarks")) -eq "test bookmarks") "bookmarks lost"
$DebugPort = 43128
$script:ownedPath = Join-Path $fixtureRoot "unrelated-profile"
function Get-NetTCPConnection { param($LocalPort, $State, $ErrorAction) return [pscustomobject]@{OwningProcess=123} }
function Get-CimInstance { param($ClassName, $Filter, $ErrorAction) return [pscustomobject]@{CommandLine=('msedge.exe --user-data-dir="' + $script:ownedPath + '" --remote-debugging-port=43128')} }
function Invoke-RestMethod { param($Uri, $TimeoutSec) return @{} }
Complete-BrowserProfileMigration -Profile $profile
Assert-That (Test-Path -LiteralPath $legacy) "unrelated debug listener deleted legacy"
$script:ownedPath = $profile
$marker = Join-Path $profile ".migrated-from"
Set-Content -LiteralPath $marker -Value $fixtureRoot -Encoding utf8
Complete-BrowserProfileMigration -Profile $profile
Assert-That (Test-Path -LiteralPath $legacy) "tampered marker deleted legacy"
Set-Content -LiteralPath $marker -Value $legacy -Encoding utf8
Complete-BrowserProfileMigration -Profile $profile
Assert-That (-not (Test-Path -LiteralPath $legacy)) "verified migration did not finish"
Assert-That (Test-Path -LiteralPath $profile) "destination deleted"
Assert-That (-not (Test-Path -LiteralPath $marker)) "completion marker survived"
'''
            script.write_text(body, encoding="utf-8-sig")
            result = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(script), str(source)], capture_output=True, timeout=40)
            self.assertEqual(result.returncode, 0, result.stdout.decode(errors="replace") + result.stderr.decode(errors="replace"))


if __name__ == "__main__": unittest.main()
