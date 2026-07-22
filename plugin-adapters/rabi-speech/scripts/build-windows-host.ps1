param(
  [string]$Python = "py -3.10"
)

$ErrorActionPreference = "Stop"
$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$repo = [IO.Path]::GetFullPath((Join-Path $root "..\.."))
$buildDeps = Join-Path $root ".builddeps"
$runtime = Join-Path $root "runtime"
$work = Join-Path $root "temp\pyinstaller-windows-host"
$entry = Join-Path $PSScriptRoot "windows_host.py"
$patcher = Join-Path $PSScriptRoot "patch_windows_launcher.py"
$version = Join-Path $PSScriptRoot "rabispeech-version-info.txt"
$icon = Join-Path $repo "assets\rabiroute-icon.ico"

foreach ($required in @($entry, $patcher, $version, $icon)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "RabiSpeech Windows host build input is missing: $required"
  }
}

$pythonArgs = $Python -split "\s+"
$pythonExe = $pythonArgs[0]
$prefixArgs = @($pythonArgs | Select-Object -Skip 1)
& $pythonExe @prefixArgs -c "import sys; assert (3, 10) <= sys.version_info[:2] < (3, 13)"
if ($LASTEXITCODE -ne 0) { throw "RabiSpeech Windows host requires Python 3.10-3.12." }

New-Item -ItemType Directory -Force -Path $buildDeps, $runtime | Out-Null
$previousPythonPath = $env:PYTHONPATH
$previousPythonHome = $env:PYTHONHOME
$previousPath = $env:PATH
try {
  $env:PYTHONPATH = $buildDeps + $(if ($previousPythonPath) { ";$previousPythonPath" } else { "" })
  & $pythonExe @prefixArgs -c "import PyInstaller" 2>$null
  if ($LASTEXITCODE -ne 0) {
    & $pythonExe @prefixArgs -m pip install --upgrade --target $buildDeps "pyinstaller==6.16.0"
    if ($LASTEXITCODE -ne 0) { throw "Failed to install the RabiSpeech Windows host build dependency." }
  }

  $pythonExecutable = (& $pythonExe @prefixArgs -c "import sys; print(sys.executable)").Trim()
  $pythonHome = (& $pythonExe @prefixArgs -c "import sys; print(sys.base_prefix)").Trim()
  if (-not (Test-Path -LiteralPath $pythonExecutable -PathType Leaf)) {
    throw "Resolved Python executable is missing: $pythonExecutable"
  }

  $hostExe = Join-Path $runtime "RabiSpeech.exe"
  & $pythonExe @prefixArgs $patcher `
    --source $pythonExecutable `
    --destination $hostExe `
    --version-file $version `
    --icon $icon
  if ($LASTEXITCODE -ne 0) { throw "RabiSpeech Windows host resource patch failed." }

  $env:PYTHONHOME = $pythonHome
  $env:PATH = "$pythonHome;$previousPath"
  $env:RABISPEECH_ROOT = $root
  $probe = & $hostExe $entry --probe | ConvertFrom-Json
  if ([IO.Path]::GetFullPath([string]$probe.service_root) -ne $root) {
    throw "RabiSpeech Windows host probe resolved the wrong runtime root."
  }
} finally {
  $env:PYTHONPATH = $previousPythonPath
  $env:PYTHONHOME = $previousPythonHome
  $env:PATH = $previousPath
}

$hostExe = Join-Path $runtime "RabiSpeech.exe"
if (-not (Test-Path -LiteralPath $hostExe -PathType Leaf)) {
  throw "RabiSpeech Windows host output is missing: $hostExe"
}

Get-Item -LiteralPath $hostExe | Select-Object FullName, Length, LastWriteTime
