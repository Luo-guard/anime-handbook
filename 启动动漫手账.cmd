@echo off
setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\launch_handbook.ps1"
if errorlevel 1 (
  echo.
  echo The anime handbook could not be started. See the message above.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\activate_handbook_browser.ps1" -Url "http://127.0.0.1:43127"
endlocal
