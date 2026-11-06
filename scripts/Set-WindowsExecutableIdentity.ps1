param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][string]$Description,
    [string]$OriginalFilename,
    [string]$Icon,
    [string]$Python = "python.exe"
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$buildDependencies = Join-Path $env:LOCALAPPDATA "RabiRoute\build-cache\executable-identity-pyinstaller-6.16.0"
$previousPythonPath = $env:PYTHONPATH
if (-not $OriginalFilename) { $OriginalFilename = Split-Path -Leaf $Destination }
if (-not $Icon) { $Icon = Join-Path $repo "assets\rabiroute-icon.ico" }
try {
    $env:PYTHONPATH = $buildDependencies
    & $Python -c "import importlib.util; raise SystemExit(0 if importlib.util.find_spec('PyInstaller') else 1)"
    if ($LASTEXITCODE -ne 0) {
        & $Python -m pip install --disable-pip-version-check --ignore-installed --no-warn-conflicts --target $buildDependencies "pyinstaller==6.16.0"
        if ($LASTEXITCODE -ne 0) { throw "Installing Windows executable resource build tools failed." }
    }
    & $Python (Join-Path $PSScriptRoot "lib\patch-windows-executable.py") `
        --source $Source --destination $Destination --description $Description --original-filename $OriginalFilename `
        --icon $Icon
    if ($LASTEXITCODE -ne 0) { throw "Windows process identity generation failed for $Description." }
} finally { $env:PYTHONPATH = $previousPythonPath }
