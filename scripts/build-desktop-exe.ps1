# scripts/build-desktop-exe.ps1
# Windows 完整桌面运行包的本地构建入口。
# 唯一真源见 docs/windows-launcher-and-packaging.md。
# 注意：RabiRoute-Desktop.exe 只是Windows 桌面入口，不是单文件完整包；完整运行态还需要
# dist/ 后端产物、ribiwebgui/dist 前端产物、Node runtime、npm 依赖和外置可写 data/。
# 用法：
#   cd <repo>
#   .\scripts\build-desktop-exe.ps1
#   .\scripts\build-desktop-exe.ps1 -SkipNodeBuild   # 跳过 Node.js 构建
#   .\scripts\build-desktop-exe.ps1 -SkipCopy        # 不把 exe 复制到项目根目录
param(
    [switch]$SkipNodeBuild,
    [switch]$SkipCopy
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Resolve-Path (Join-Path $scriptDir "..")
Set-Location $repo

function Write-Step([string]$msg) { Write-Host "[build-desktop-exe] $msg" }

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
# A repository on a NAS can contain a venv copied from another Windows PC. Its
# python.exe may exist while still pointing at a base interpreter that is absent
# on this machine, so probe every candidate instead of trusting file existence.
$pythonCandidates = @(
    (Join-Path $repo "desktop\tray-task-window\.venv\Scripts\python.exe"),
    (Join-Path $repo ".venv-tray\Scripts\python.exe")
)
$pyCmd = Get-Command py.exe -ErrorAction SilentlyContinue
if ($pyCmd) { $pythonCandidates += $pyCmd.Source }
$pythonCmd = Get-Command python.exe -ErrorAction SilentlyContinue
if ($pythonCmd) { $pythonCandidates += $pythonCmd.Source }

$venvPy = $null
foreach ($candidate in $pythonCandidates | Select-Object -Unique) {
    if (-not (Test-Path -LiteralPath $candidate)) { continue }
    $probeExitCode = 1
    $previousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & $candidate -c "import sys" 2>$null
        $probeExitCode = $LASTEXITCODE
    } catch {
        $probeExitCode = 1
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
    if ($probeExitCode -eq 0) {
        $venvPy = $candidate
        break
    }
    Write-Step "Ignoring unusable Python candidate: $candidate"
}
if (-not $venvPy) { throw "No usable Python was found. Install Python 3.10+ or create a local venv." }
Write-Step "Using Python: $venvPy"

# ── 3. 确保桌面依赖与 PyInstaller 已安装 ────────────────────────────────────
# Use the module entry point so the Windows py.exe launcher and ordinary
# python.exe/venv interpreters all follow the same path.
$trayDependencyProbe = 1
$previousErrorAction = $ErrorActionPreference
try {
    $ErrorActionPreference = "Continue"
    & $venvPy -c "import PySide6, uiautomation, PIL" 2>$null
    $trayDependencyProbe = $LASTEXITCODE
} catch {
    $trayDependencyProbe = 1
} finally {
    $ErrorActionPreference = $previousErrorAction
}
if ($trayDependencyProbe -ne 0) {
    Write-Step "Tray dependencies are missing. Installing requirements..."
    & $venvPy -m pip install -r "$repo\desktop\tray-task-window\requirements.txt"
    if ($LASTEXITCODE -ne 0) { throw "Failed to install tray requirements." }
}

$pyInstallerProbe = 1
$previousErrorAction = $ErrorActionPreference
try {
    $ErrorActionPreference = "Continue"
    & $venvPy -c "import PyInstaller" 2>$null
    $pyInstallerProbe = $LASTEXITCODE
} catch {
    $pyInstallerProbe = 1
} finally {
    $ErrorActionPreference = $previousErrorAction
}
if ($pyInstallerProbe -ne 0) {
    Write-Step "PyInstaller not found. Installing..."
    & $venvPy -m pip install pyinstaller
    if ($LASTEXITCODE -ne 0) { throw "Failed to install PyInstaller." }
}

# ── 4. 打包 ──────────────────────────────────────────────────────────────────
Write-Step "Running PyInstaller..."
& $venvPy -m PyInstaller "$repo\RabiRoute-Desktop.spec" --noconfirm
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed." }

$exeSrc = Join-Path $repo "dist\RabiRoute-Desktop.exe"
if (-not (Test-Path $exeSrc)) { throw "Expected output not found: $exeSrc" }
Write-Step "Built: $exeSrc"

# ── 5. 复制到项目根目录 ──────────────────────────────────────────────────────
if (-not $SkipCopy) {
    $exeDst = Join-Path $repo "RabiRoute-Desktop.exe"
    try {
        Copy-Item -LiteralPath $exeSrc -Destination $exeDst -Force -ErrorAction Stop
        Write-Step "Copied to: $exeDst"
    } catch {
        $fallbackExe = Join-Path $repo "RabiRoute-Desktop.new.exe"
        Copy-Item -LiteralPath $exeSrc -Destination $fallbackExe -Force
        Write-Step "Could not replace $exeDst because it is probably running."
        Write-Step "Copied the new build to: $fallbackExe"
        Write-Step "Close the existing RabiRoute Desktop process, then replace RabiRoute-Desktop.exe with this file."
    }
    Write-Step ""
    Write-Step "Done! Double-click RabiRoute-Desktop.exe to launch."
    Write-Step "  - Starts RabiRoute manager (node dist/manager.js) automatically if not running."
    Write-Step "  - Serves RibiWebGUI from ribiwebgui/dist through the manager."
    Write-Step "  - Shows the system tray entry and Rabi task window as one RabiRoute Desktop application."
    Write-Step ""
    Write-Step "Requires Node.js and npm dependencies at runtime; see docs/windows-launcher-and-packaging.md."
}
