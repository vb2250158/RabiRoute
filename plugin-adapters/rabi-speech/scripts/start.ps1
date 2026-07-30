param(
  [string]$Python = "py -3.10",
  [switch]$Reload
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$deps = Join-Path $root ".deps"
$config = Join-Path $root "config.json"
if (!(Test-Path -LiteralPath $config)) {
  Copy-Item -LiteralPath (Join-Path $root "config.example.json") -Destination $config
}
$depsAvailable = $false
for ($attempt = 1; $attempt -le 5; $attempt++) {
  if (Test-Path -LiteralPath $deps -PathType Container) {
    $depsAvailable = $true
    break
  }
  if ($attempt -lt 5) {
    Start-Sleep -Seconds 2
  }
}
if (!$depsAvailable) {
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
if (-not $Reload -and $env:OS -eq "Windows_NT" -and (Test-Path -LiteralPath $hostExe -PathType Leaf)) {
  & $hostExe $hostScript
  exit $LASTEXITCODE
}

$hostArgs = @($hostScript)
if ($Reload) {
  $hostArgs += "--reload"
}
& $pythonExe @prefixArgs @hostArgs
