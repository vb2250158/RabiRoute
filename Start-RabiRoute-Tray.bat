@echo off
setlocal

cd /d "%~dp0"

where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo [RabiRoute] powershell.exe was not found.
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-rabiroute-windows.ps1" -PauseAtEnd
exit /b %errorlevel%
