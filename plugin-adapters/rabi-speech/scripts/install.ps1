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

$openJTalkPackage = Join-Path $deps "pyopenjtalk"
$openJTalkDictionary = Join-Path $openJTalkPackage "open_jtalk_dic_utf_8-1.11"
if ((Test-Path -LiteralPath $openJTalkPackage) -and -not (Test-Path -LiteralPath $openJTalkDictionary)) {
  $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  $extractRoot = Join-Path $tempBase ("rabispeech-openjtalk-" + [Guid]::NewGuid().ToString("N"))
  $archivePath = Join-Path $extractRoot "open_jtalk_dic_utf_8-1.11.tar.gz"
  New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
  try {
    Write-Host "Downloading the official OpenJTalk dictionary for offline Japanese ONNX-VITS..."
    Invoke-WebRequest -Uri "https://github.com/r9y9/open_jtalk/releases/download/v1.11.1/open_jtalk_dic_utf_8-1.11.tar.gz" -OutFile $archivePath
    & tar.exe -xzf $archivePath -C $extractRoot
    if ($LASTEXITCODE -ne 0) { throw "OpenJTalk dictionary extraction failed with exit code $LASTEXITCODE" }
    $extractedDictionary = Join-Path $extractRoot "open_jtalk_dic_utf_8-1.11"
    if (-not (Test-Path -LiteralPath $extractedDictionary)) { throw "The OpenJTalk archive did not contain the expected dictionary directory." }
    Move-Item -LiteralPath $extractedDictionary -Destination $openJTalkDictionary
  }
  finally {
    $resolvedExtractRoot = [IO.Path]::GetFullPath($extractRoot)
    if ($resolvedExtractRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $resolvedExtractRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

Write-Host "RabiSpeech dependencies installed: $deps"
