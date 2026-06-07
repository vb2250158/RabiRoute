# scripts/build-tray-exe.ps1
# 把 RabiRoute 托盘程序打包成单个 Windows exe。
# 用法：
#   cd <repo>
#   .\scripts\build-tray-exe.ps1
#   .\scripts\build-tray-exe.ps1 -SkipNodeBuild   # 跳过 Node.js 构建
#   .\scripts\build-tray-exe.ps1 -SkipCopy        # 不把 exe 复制到项目根目录
param(
    [switch]$SkipNodeBuild,
    [switch]$SkipCopy
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Resolve-Path (Join-Path $scriptDir "..")
Set-Location $repo

function Write-Step([string]$msg) { Write-Host "[build-tray-exe] $msg" }

# ── 1. Node.js 构建 ──────────────────────────────────────────────────────────
if (-not $SkipNodeBuild) {
    Write-Step "Building Node.js backend + frontend..."
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { throw "npm.cmd not found. Install Node.js first." }
    & cmd /c "cd /d `"$repo`" && npm run build"
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed." }
    Write-Step "Node.js build done."
}

# ── 2. Python 环境 ───────────────────────────────────────────────────────────
$venvPy = Join-Path $repo "desktop\tray-task-window\.venv\Scripts\python.exe"
if (-not (Test-Path $venvPy)) {
    # Try project-level venv
    $venvPy = Join-Path $repo ".venv-tray\Scripts\python.exe"
}
if (-not (Test-Path $venvPy)) {
    $pyCmd = Get-Command py.exe -ErrorAction SilentlyContinue
    if (-not $pyCmd) { $pyCmd = Get-Command python.exe -ErrorAction SilentlyContinue }
    if (-not $pyCmd) { throw "Python not found. Install Python 3.11+ or create a venv first." }
    $venvPy = $pyCmd.Source
}
Write-Step "Using Python: $venvPy"

# ── 3. 确保 PyInstaller 已安装 ───────────────────────────────────────────────
# Prefer the .exe in the same Scripts folder; fall back to -m pyinstaller.
$piExe = [System.IO.Path]::ChangeExtension($venvPy, $null).TrimEnd('.') `
    -replace '\\python$', '\pyinstaller'
$piExe = Join-Path (Split-Path $venvPy) "pyinstaller.exe"
if (-not (Test-Path $piExe)) {
    Write-Step "PyInstaller not found. Installing..."
    & $venvPy -m pip install pyinstaller
    if ($LASTEXITCODE -ne 0) { throw "Failed to install PyInstaller." }
}
if (-not (Test-Path $piExe)) { throw "pyinstaller.exe still not found after install." }

# ── 4. 打包 ──────────────────────────────────────────────────────────────────
Write-Step "Running PyInstaller..."
& $piExe "$repo\RabiRoute-Tray.spec" --noconfirm
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed." }

$exeSrc = Join-Path $repo "dist\RabiRoute-Tray.exe"
if (-not (Test-Path $exeSrc)) { throw "Expected output not found: $exeSrc" }
Write-Step "Built: $exeSrc"

# ── 5. 复制到项目根目录 ──────────────────────────────────────────────────────
if (-not $SkipCopy) {
    $exeDst = Join-Path $repo "RabiRoute-Tray.exe"
    Copy-Item -LiteralPath $exeSrc -Destination $exeDst -Force
    Write-Step "Copied to: $exeDst"
    Write-Step ""
    Write-Step "Done! Double-click RabiRoute-Tray.exe to launch."
    Write-Step "  - Starts RabiRoute manager (node dist/manager.js) automatically if not running."
    Write-Step "  - Shows system tray icon + Rabi task window."
    Write-Step ""
    Write-Step "Requires Node.js on PATH at runtime (for the manager)."
}
