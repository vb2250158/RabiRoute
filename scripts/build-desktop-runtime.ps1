param(
    [string]$OutputRoot,
    [string]$Python = "py.exe",
    [string]$PythonVersion = "3.10.11"
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = [System.IO.Path]::GetFullPath((Join-Path $scriptDir ".."))

function Write-Step([string]$Message) { Write-Host "[build-desktop-runtime] $Message" }

function Assert-LocalDirectory([string]$PathValue) {
    $fullPath = [System.IO.Path]::GetFullPath($PathValue)
    $root = [System.IO.Path]::GetPathRoot($fullPath).TrimEnd("\\")
    $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$root'" -ErrorAction SilentlyContinue
    if ($disk -and $disk.DriveType -eq 4) {
        throw "Desktop runtime output must be built on a local disk, not a network drive: $fullPath"
    }
    return $fullPath
}

if (-not $OutputRoot) {
    $OutputRoot = Join-Path $env:LOCALAPPDATA "RabiRoute\build\desktop-runtime"
}
$OutputRoot = Assert-LocalDirectory $OutputRoot
$hostSource = Join-Path $repo "desktop\tray-task-window"
$pythonRoot = Join-Path $OutputRoot "python"
$runtimePython = Join-Path $pythonRoot "python.exe"
$runtimePythonw = Join-Path $pythonRoot "pythonw.exe"

if (Test-Path -LiteralPath $OutputRoot) {
    Remove-Item -LiteralPath $OutputRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null

Write-Step "Copying the versioned Qt host source"
Copy-Item -LiteralPath (Join-Path $hostSource "main.py") -Destination (Join-Path $OutputRoot "main.py") -Force
Copy-Item -LiteralPath (Join-Path $hostSource "rabiroute_tray") -Destination (Join-Path $OutputRoot "rabiroute_tray") -Recurse -Force
Get-ChildItem -LiteralPath $OutputRoot -Recurse -Directory -Filter "__pycache__" | Remove-Item -Recurse -Force

Write-Step "Creating portable Python $PythonVersion Qt runtime"
$cacheRoot = Join-Path $env:LOCALAPPDATA "RabiRoute\build-cache"
New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null
$pythonArchive = Join-Path $cacheRoot "python-$PythonVersion-embed-amd64.zip"
if (-not (Test-Path -LiteralPath $pythonArchive -PathType Leaf)) {
    Invoke-WebRequest -UseBasicParsing `
        -Uri "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip" `
        -OutFile $pythonArchive
}
Expand-Archive -LiteralPath $pythonArchive -DestinationPath $pythonRoot -Force
if (-not (Test-Path -LiteralPath $runtimePython -PathType Leaf) -or
    -not (Test-Path -LiteralPath $runtimePythonw -PathType Leaf)) {
    throw "The embeddable Python runtime is incomplete."
}
$sitePackages = Join-Path $pythonRoot "Lib\site-packages"
New-Item -ItemType Directory -Force -Path $sitePackages | Out-Null
$pthFile = Get-ChildItem -LiteralPath $pythonRoot -File -Filter "python*._pth" | Select-Object -First 1
if (-not $pthFile) { throw "The embeddable Python path configuration is missing." }
@("python310.zip", ".", "..", "Lib\site-packages", "import site") |
    Set-Content -LiteralPath $pthFile.FullName -Encoding ASCII
& $Python -3.10 -m pip install --disable-pip-version-check --ignore-installed --no-warn-conflicts --target $sitePackages `
    -r (Join-Path $hostSource "requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "Installing RabiRoute Desktop Qt dependencies failed." }

# pip --target can leave build-time command wrappers and bytecode caches. The
# hosted tray imports libraries directly and needs neither in the release image.
$toolBin = Join-Path $sitePackages "bin"
if (Test-Path -LiteralPath $toolBin) {
    Remove-Item -LiteralPath $toolBin -Recurse -Force
}
Get-ChildItem -LiteralPath $pythonRoot -Recurse -Directory -Filter "__pycache__" |
    Remove-Item -Recurse -Force

# PySide6 wheels also ship QML sources, C++ headers, type metadata, linker files,
# and development tools. This application is a Qt Widgets surface and never
# loads QML or those build-time assets. Keeping them would expand the attack and
# packaging surface and can exceed Windows installer path limits.
$pysideRoot = Join-Path $sitePackages "PySide6"
foreach ($developmentTree in @("qml", "metatypes", "include", "typesystems", "glue", "scripts", "support")) {
    $developmentPath = Join-Path $pysideRoot $developmentTree
    if (Test-Path -LiteralPath $developmentPath) {
        Remove-Item -LiteralPath $developmentPath -Recurse -Force
    }
}
foreach ($developmentPlugin in @("designer", "qmllint", "qmltooling")) {
    $developmentPluginPath = Join-Path $pysideRoot ("plugins\" + $developmentPlugin)
    if (Test-Path -LiteralPath $developmentPluginPath) {
        Remove-Item -LiteralPath $developmentPluginPath -Recurse -Force
    }
}
Get-ChildItem -LiteralPath $pysideRoot -Recurse -Force -File | Where-Object {
    $_.Extension -in @(".exe", ".exp", ".lib", ".pdb", ".prl", ".pyi") -or $_.Name -eq "py.typed"
} | Remove-Item -Force

$qtSmoke = @'
from PySide6 import QtCore, QtGui, QtNetwork, QtWidgets
import PIL, uiautomation
from rabiroute_tray import desktop_diagnostics
app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
icon = QtWidgets.QSystemTrayIcon(QtGui.QIcon())
server = QtNetwork.QLocalServer()
assert icon is not None and server is not None
print(QtCore.__version__)
'@
$previousQpaPlatform = $env:QT_QPA_PLATFORM
$env:QT_QPA_PLATFORM = "offscreen"
try {
    & $runtimePython -B -I -c $qtSmoke
    if ($LASTEXITCODE -ne 0) {
        throw "The packaged RabiRoute Desktop runtime failed its Qt Widgets lifecycle smoke test."
    }
} finally {
    $env:QT_QPA_PLATFORM = $previousQpaPlatform
}

Write-Step "Built modular Qt host runtime: $OutputRoot"
