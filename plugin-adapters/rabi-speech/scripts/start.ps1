param(
  [string]$Python = "py -3.10"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$deps = Join-Path $root ".deps"
$config = Join-Path $root "config.json"
if (!(Test-Path -LiteralPath $config)) {
  Copy-Item -LiteralPath (Join-Path $root "config.example.json") -Destination $config
}
if (!(Test-Path -LiteralPath $deps)) {
  throw "RabiSpeech dependencies are missing. Run scripts\install.ps1 first."
}

$env:PYTHONPATH = "$deps;$root" + $(if ($env:PYTHONPATH) { ";$env:PYTHONPATH" } else { "" })
$nvidiaRoot = Join-Path $deps "nvidia"
if (Test-Path -LiteralPath $nvidiaRoot) {
  $nvidiaBins = Get-ChildItem -LiteralPath $nvidiaRoot -Directory |
    ForEach-Object { Join-Path $_.FullName "bin" } |
    Where-Object { Test-Path -LiteralPath $_ }
  if ($nvidiaBins) {
    $env:PATH = (($nvidiaBins -join ";") + ";" + $env:PATH)
  }
}
$env:RABISPEECH_CONFIG = $config
$env:RABISPEECH_ROOT = $root
$pythonArgs = $Python -split "\s+"
$pythonExe = $pythonArgs[0]
$prefixArgs = @($pythonArgs | Select-Object -Skip 1)
$pythonHome = (& $pythonExe @prefixArgs -c "import sys; print(sys.base_prefix)").Trim()
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $pythonHome -PathType Container)) {
  throw "RabiSpeech could not resolve the configured Python home."
}
$env:PYTHONHOME = $pythonHome
$env:PATH = "$pythonHome;$env:PATH"
$hostScript = Join-Path $PSScriptRoot "windows_host.py"
$hostExe = Join-Path $root "runtime\RabiSpeech.exe"
if ($env:OS -eq "Windows_NT" -and (Test-Path -LiteralPath $hostExe -PathType Leaf)) {
  & $hostExe $hostScript
  exit $LASTEXITCODE
}

& $pythonExe @prefixArgs $hostScript
