# scripts/build-tray-exe.ps1
# Windows 完整桌面运行包的本地构建入口。
# 唯一真源见 docs/windows-launcher-and-packaging.md。
# 注意：RabiRoute-Tray.exe 只是托盘入口，不是单文件完整包；完整运行态还需要
# dist/ 后端产物、ribiwebgui/dist 前端产物、Node runtime、npm 依赖和外置可写 data/。
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
    if (-not (Test-Path (Join-Path $repo "dist\manager.js"))) {
        throw "Backend build output is missing: dist\manager.js"
    }
    if (-not (Test-Path (Join-Path $repo "ribiwebgui\dist\index.html"))) {
        throw "WebGUI build output is missing: ribiwebgui\dist\index.html"
    }
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
    try {
        Copy-Item -LiteralPath $exeSrc -Destination $exeDst -Force -ErrorAction Stop
        Write-Step "Copied to: $exeDst"
    } catch {
        $fallbackExe = Join-Path $repo "RabiRoute-Tray.new.exe"
        Copy-Item -LiteralPath $exeSrc -Destination $fallbackExe -Force
        Write-Step "Could not replace $exeDst because it is probably running."
        Write-Step "Copied the new build to: $fallbackExe"
        Write-Step "Close the existing RabiRoute tray process, then replace RabiRoute-Tray.exe with this file."
    }
    Write-Step ""
    Write-Step "Done! Double-click RabiRoute-Tray.exe to launch."
    Write-Step "  - Starts RabiRoute manager (node dist/manager.js) automatically if not running."
    Write-Step "  - Serves RibiWebGUI from ribiwebgui/dist through the manager."
    Write-Step "  - Shows system tray icon + Rabi task window."
    Write-Step ""
    Write-Step "Requires Node.js and npm dependencies at runtime; see docs/windows-launcher-and-packaging.md."
}
