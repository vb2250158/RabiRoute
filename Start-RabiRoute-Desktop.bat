@echo off
setlocal
set "RABIROUTE_ROOT=%~dp0"
set "RABIROUTE_HOST=%RABIROUTE_ROOT%RabiRouteHost.exe"

if not exist "%RABIROUTE_HOST%" (
  set "RABIROUTE_ROOT=%LOCALAPPDATA%\Programs\RabiRoute\"
  set "RABIROUTE_HOST=%LOCALAPPDATA%\Programs\RabiRoute\RabiRouteHost.exe"
)
if not exist "%RABIROUTE_HOST%" (
  echo RabiRouteHost.exe was not found. Install RabiRoute or place a packaged Host beside this launcher. 1>&2
  exit /b 2
)

start "" "%RABIROUTE_HOST%" %*
exit /b 0
