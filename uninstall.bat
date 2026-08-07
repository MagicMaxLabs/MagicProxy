@echo off
REM Double-click to remove MagicProxy's native-host registration.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" -Uninstall
echo.
pause
