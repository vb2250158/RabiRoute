param(
  [string]$OutputRoot,
  [string]$VenvRoot
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $OutputRoot) { $OutputRoot = Join-Path $root "dist" }
$venv = if ($VenvRoot) { [IO.Path]::GetFullPath($VenvRoot) } else { Join-Path $root ".venv-build310" }
py -3.10 -m venv $venv
& (Join-Path $venv "Scripts\python.exe") -m pip install --upgrade pip
& (Join-Path $venv "Scripts\python.exe") -m pip install -r (Join-Path $root "requirements.txt") pyinstaller
& (Join-Path $venv "Scripts\pyinstaller.exe") `
  --noconfirm `
  --clean `
  --onefile `
  --windowed `
  --name RabiVoiceClient `
  --icon (Join-Path $root "..\..\assets\rabiroute-icon.ico") `
  --add-data "$(Join-Path $root '..\..\assets\rabiroute-icon.png');assets" `
  --collect-binaries sounddevice `
  --hidden-import websockets.asyncio.client `
  --distpath $OutputRoot `
  --workpath (Join-Path $root "build") `
  --specpath (Join-Path $root "build") `
  (Join-Path $root "main.py")
Copy-Item -LiteralPath (Join-Path $root "config.example.json") -Destination (Join-Path $OutputRoot "config.example.json") -Force
Compress-Archive -Path (Join-Path $OutputRoot "RabiVoiceClient.exe"), (Join-Path $OutputRoot "config.example.json") -DestinationPath (Join-Path $OutputRoot "RabiVoiceClient-windows-x64.zip") -Force
Write-Host "Built: $OutputRoot\RabiVoiceClient.exe"
Write-Host "Package: $OutputRoot\RabiVoiceClient-windows-x64.zip"
