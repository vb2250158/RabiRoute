param(
  [string]$Python = "py -3.10",
  [switch]$Reload
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$deps = Join-Path $root ".deps"
$dataRoot = if ($env:RABISPEECH_DATA_ROOT) {
  $env:RABISPEECH_DATA_ROOT
} elseif ($env:LOCALAPPDATA) {
  Join-Path $env:LOCALAPPDATA "RabiPC\RabiSpeech"
} else {
  $root
}
$config = if ($env:RABISPEECH_CONFIG) { $env:RABISPEECH_CONFIG } else { Join-Path $dataRoot "config.json" }
if (!(Test-Path -LiteralPath $config)) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $config) | Out-Null
  $legacyConfig = Join-Path $root "config.json"
  $configSource = if (Test-Path -LiteralPath $legacyConfig) { $legacyConfig } else { Join-Path $root "config.example.json" }
  Copy-Item -LiteralPath $configSource -Destination $config
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
$env:RABISPEECH_DATA_ROOT = (Split-Path -Parent $config)
$env:RABISPEECH_CONFIG = $config
$env:RABISPEECH_ROOT = $root
$env:RABISPEECH_MODEL_ROOT = if ($env:RABISPEECH_MODEL_ROOT) { $env:RABISPEECH_MODEL_ROOT } else { Join-Path (Split-Path -Parent $env:RABISPEECH_DATA_ROOT) "models\rabispeech" }
$env:RABISPEECH_WHISPER_MODEL_ROOT = if ($env:RABISPEECH_WHISPER_MODEL_ROOT) { $env:RABISPEECH_WHISPER_MODEL_ROOT } else { Join-Path $env:RABISPEECH_MODEL_ROOT "asr\faster-whisper-cache" }
$env:RABISPEECH_SPEAKER_MODEL_PATH = if ($env:RABISPEECH_SPEAKER_MODEL_PATH) { $env:RABISPEECH_SPEAKER_MODEL_PATH } else { Join-Path $env:RABISPEECH_MODEL_ROOT "speaker\3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx" }
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
