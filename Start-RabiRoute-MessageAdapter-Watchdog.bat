@echo off
setlocal
set "SCRIPT=%~dp0scripts\watch-rabiroute-health.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
exit /b %errorlevel%
