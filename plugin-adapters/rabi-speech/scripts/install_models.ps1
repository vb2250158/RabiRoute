param(
  [switch]$List,
  [ValidateSet(
    "all",
    "tts-qwen3-0.6b",
    "tts-qwen3-1.7b",
    "tts-cosyvoice3-0.5b",
    "tts-gpt-sovits",
    "tts-indextts2",
    "asr-whisper-tiny",
    "asr-whisper-small",
    "asr-whisper-large-v3-turbo",
    "asr-qwen3-0.6b",
    "asr-qwen3-1.7b",
    "asr-sensevoice-small",
    "asr-fireredasr2-aed",
    "speaker-eres2netv2-zh",
    "speaker-campplus-zh"
  )]
  [string[]]$Model,
  [string]$ModelRoot = "",
  [ValidateRange(1, 32)]
  [int]$MaxWorkers = 4,
  [ValidateRange(10, 3600)]
  [int]$DownloadTimeout = 180,
  [ValidateRange(10, 3600)]
  [int]$EtagTimeout = 60,
  [string]$Python = "py -3.10"
)

$ErrorActionPreference = "Stop"
$pluginRoot = Split-Path -Parent $PSScriptRoot
$deps = Join-Path $pluginRoot ".deps"
$downloader = Join-Path $PSScriptRoot "install_models.py"

if (-not (Test-Path -LiteralPath $downloader)) {
  throw "RabiSpeech model downloader was not found: $downloader"
}
if (-not (Test-Path -LiteralPath $deps)) {
  throw "RabiSpeech dependencies are missing. Run scripts\install.ps1 first."
}
if ([string]::IsNullOrWhiteSpace($ModelRoot)) {
  $ModelRoot = if ($env:RABISPEECH_MODEL_ROOT) {
    $env:RABISPEECH_MODEL_ROOT
  } else {
    Join-Path (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $pluginRoot))) "models\rabispeech"
  }
}

$env:PYTHONPATH = "$deps;$pluginRoot" + $(if ($env:PYTHONPATH) { ";$env:PYTHONPATH" } else { "" })
$pythonParts = $Python -split "\s+"
$pythonExe = $pythonParts[0]
$arguments = @($pythonParts | Select-Object -Skip 1) + @(
  $downloader,
  "--root", $ModelRoot,
  "--max-workers", [string]$MaxWorkers,
  "--download-timeout", [string]$DownloadTimeout,
  "--etag-timeout", [string]$EtagTimeout
)
if ($List) {
  $arguments += "--list"
} elseif ($Model) {
  foreach ($alias in $Model) {
    $arguments += @("--model", $alias)
  }
}

& $pythonExe @arguments
exit $LASTEXITCODE
