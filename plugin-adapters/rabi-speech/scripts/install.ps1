param(
  [string]$Python = "py -3.10"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$deps = Join-Path $root ".deps"
New-Item -ItemType Directory -Force -Path $deps | Out-Null

$pythonArgs = $Python -split "\s+"
$pythonExe = $pythonArgs[0]
$prefixArgs = @($pythonArgs | Select-Object -Skip 1)
& $pythonExe @prefixArgs -m pip install --upgrade --target $deps -r (Join-Path $root "requirements.txt")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "RabiSpeech dependencies installed: $deps"
