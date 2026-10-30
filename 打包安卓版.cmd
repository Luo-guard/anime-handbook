@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\build_android.ps1"
if errorlevel 1 (
  echo Android build failed.
  pause
  exit /b 1
)
echo Android APK is in releases\android.
pause
endlocal
