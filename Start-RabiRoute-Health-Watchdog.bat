@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\watch-rabiroute-health.ps1" -IntervalSeconds 1800
