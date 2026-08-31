param(
  [string]$TaskName = "RabiSpeech",
  [switch]$StartNow
)

$ErrorActionPreference = "Stop"
throw @"
install-service.ps1 has been retired. RabiSpeech must not register an independent
scheduled task or survive outside a RabiRoute application generation.

Install the optional speech dependencies with scripts\install.ps1, then start
RabiRouteHost.exe. The Manager speech plugin owns the RabiSpeech process. Windows
sign-in autostart must point only to RabiRouteHost.exe.
"@
