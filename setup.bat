@echo off
REM Double-click to install MagicProxy (registers the native host, downloads sing-box if needed).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
echo.
pause
