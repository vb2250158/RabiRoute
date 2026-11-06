param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("qwen-asr", "sensevoice", "fireredasr2", "cosyvoice3", "gpt-sovits")]
  [string]$Runtime,
  [string]$Python = "py -3.10",
  [string]$InstallRoot = "D:\RabiSpeechRuntimes",
  [string]$CosyVoiceRoot = "",
  [string]$FireRedRoot = "",
  [string]$GptSoVitsRoot = ""
)

$ErrorActionPreference = "Stop"
$env:PIP_DEFAULT_TIMEOUT = "180"
$env:PIP_RETRIES = "20"

if ([string]::IsNullOrWhiteSpace($CosyVoiceRoot)) { $CosyVoiceRoot = Join-Path $InstallRoot "CosyVoice" }
if ([string]::IsNullOrWhiteSpace($FireRedRoot)) { $FireRedRoot = Join-Path $InstallRoot "FireRedASR2S" }
if ([string]::IsNullOrWhiteSpace($GptSoVitsRoot)) { $GptSoVitsRoot = Join-Path $InstallRoot "GPT-SoVITS" }

function Invoke-Checked {
  param([string]$FilePath, [string[]]$Arguments)
  & $FilePath @Arguments | Out-Host
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "Command failed with exit code ${exitCode}: $FilePath $($Arguments -join ' ')"
  }
}

function New-RuntimeVenv {
  param([string]$Root)
  New-Item -ItemType Directory -Force -Path $Root | Out-Null
  $venv = Join-Path $Root ".venv"
  if (!(Test-Path -LiteralPath (Join-Path $venv "Scripts\python.exe"))) {
    $pythonParts = $Python -split "\s+"
    $venvArgs = @($pythonParts | Select-Object -Skip 1) + @("-m", "venv", $venv)
    Invoke-Checked -FilePath $pythonParts[0] -Arguments $venvArgs
  }
  $runtimePython = Join-Path $venv "Scripts\python.exe"
  Invoke-Checked $runtimePython @("-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel")
  return $runtimePython
}

switch ($Runtime) {
  "qwen-asr" {
    $runtimePython = New-RuntimeVenv (Join-Path $InstallRoot "QwenASR")
    Invoke-Checked $runtimePython @("-m", "pip", "install", "torch", "torchaudio", "--index-url", "https://download.pytorch.org/whl/cu126")
    Invoke-Checked $runtimePython @("-m", "pip", "install", "qwen-asr")
  }
  "sensevoice" {
    $runtimePython = New-RuntimeVenv (Join-Path $InstallRoot "SenseVoice")
    Invoke-Checked $runtimePython @("-m", "pip", "install", "torch", "torchaudio", "--index-url", "https://download.pytorch.org/whl/cu126")
    Invoke-Checked $runtimePython @("-m", "pip", "install", "funasr", "modelscope", "soundfile")
  }
  "fireredasr2" {
    if (!(Test-Path -LiteralPath (Join-Path $FireRedRoot "requirements.txt"))) {
      throw "Clone the official FireRedASR2S repository first: $FireRedRoot"
    }
    $runtimePython = New-RuntimeVenv $FireRedRoot
    Invoke-Checked $runtimePython @("-m", "pip", "install", "-r", (Join-Path $FireRedRoot "requirements.txt"))
  }
  "cosyvoice3" {
    if (!(Test-Path -LiteralPath (Join-Path $CosyVoiceRoot "requirements.txt"))) {
      throw "Clone the official CosyVoice repository first: $CosyVoiceRoot"
    }
    $runtimePython = New-RuntimeVenv $CosyVoiceRoot
    Invoke-Checked $runtimePython @("-m", "pip", "install", "torch==2.3.1", "torchaudio==2.3.1", "--index-url", "https://download.pytorch.org/whl/cu121")
    Invoke-Checked $runtimePython @("-m", "pip", "install", "setuptools<81")
    Invoke-Checked $runtimePython @("-m", "pip", "install", "openai-whisper==20231117", "--no-build-isolation")
    Invoke-Checked $runtimePython @("-m", "pip", "install", "-r", (Join-Path $CosyVoiceRoot "requirements.txt"))
  }
  "gpt-sovits" {
    if (!(Test-Path -LiteralPath (Join-Path $GptSoVitsRoot "requirements.txt"))) {
      throw "Clone the official GPT-SoVITS repository first: $GptSoVitsRoot"
    }
    $runtimePython = New-RuntimeVenv $GptSoVitsRoot
    Invoke-Checked $runtimePython @("-m", "pip", "install", "torch", "torchcodec", "--index-url", "https://download.pytorch.org/whl/cu126")
    Invoke-Checked $runtimePython @("-m", "pip", "install", "-r", (Join-Path $GptSoVitsRoot "extra-req.txt"), "--no-deps")
    Invoke-Checked $runtimePython @("-m", "pip", "install", "-r", (Join-Path $GptSoVitsRoot "requirements.txt"), "imageio-ffmpeg")
  }
}

Write-Host "Installed isolated local speech runtime: $Runtime"
