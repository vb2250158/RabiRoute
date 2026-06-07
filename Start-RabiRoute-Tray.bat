<# : batch portion
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~f0" %*
exit /b %errorlevel%
: end batch / begin PowerShell #>
param(
  [string]$ManagerUrl = "http://127.0.0.1:8790",
  [string]$DefaultRouteName = "default-main",
  [switch]$NoOpen,
  [switch]$NoBuild,
  [switch]$NoTray,
  [switch]$PauseAtEnd
)


$ErrorActionPreference = "Stop"

function Write-Info {
  param([string]$Message)
  Write-Host "[RabiRoute] $Message"
}

function Wait-ForEnter {
  if ($PauseAtEnd) {
    Write-Host ""
    Read-Host "Press Enter to close this window"
  }
}

function Test-Manager {
  param([string]$Url)
  try {
    return Invoke-RestMethod -Uri "$Url/meta" -Method Get -TimeoutSec 2
  } catch {
    return $null
  }
}

function Test-TcpPort {
  param(
    [string]$HostName,
    [int]$Port
  )
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect($HostName, $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(800, $false)) {
      return $false
    }
    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Get-ExistingTrayProcesses {
  param([string]$ProjectRoot)
  $needle = (Join-Path $ProjectRoot "desktop\tray-task-window\main.py").ToLowerInvariant()
  try {
    $matches = @(Get-CimInstance Win32_Process | Where-Object {
      $_.CommandLine -and
      $_.CommandLine.ToLowerInvariant().Contains($needle)
    })
    $matchedPids = @{}
    foreach ($process in $matches) {
      $matchedPids[[int]$process.ProcessId] = $true
    }
    return @($matches | Where-Object {
      -not $matchedPids.ContainsKey([int]$_.ParentProcessId)
    })
  } catch {
    return @()
  }
}

function Stop-DuplicateTrayProcesses {
  param(
    [array]$TrayProcesses,
    [string]$LauncherLog
  )
  if ($TrayProcesses.Count -le 1) {
    return @($TrayProcesses)
  }

  $ordered = @($TrayProcesses | Sort-Object CreationDate -Descending)
  $keep = $ordered[0]
  $duplicates = @($ordered | Select-Object -Skip 1)
  $duplicatePids = ($duplicates | ForEach-Object { $_.ProcessId }) -join ", "
  $message = "Multiple Qt tray process groups were found. Keeping pid=$($keep.ProcessId), stopping duplicate root pid(s): $duplicatePids"
  Write-Info $message
  Add-Content -LiteralPath $LauncherLog -Encoding UTF8 -Value "[$(Get-Date -Format o)] $message"

  foreach ($duplicate in $duplicates) {
    try {
      Stop-Process -Id $duplicate.ProcessId -Force -ErrorAction Stop
    } catch {
      $errorMessage = "Failed to stop duplicate tray root pid=$($duplicate.ProcessId): $($_.Exception.Message)"
      Write-Info $errorMessage
      Add-Content -LiteralPath $LauncherLog -Encoding UTF8 -Value "[$(Get-Date -Format o)] $errorMessage"
    }
  }

  return @($keep)
}

function Invoke-LoggedCommand {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$LogPath,
    [string]$WorkingDirectory
  )
  $argumentText = ($Arguments | ForEach-Object {
    if ($_ -match "\s") {
      '"' + ($_ -replace '"', '\"') + '"'
    } else {
      $_
    }
  }) -join " "
  Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value "[$(Get-Date -Format o)] > $FilePath $argumentText"
  & $FilePath @Arguments 2>&1 | Tee-Object -FilePath $LogPath -Append
  if ($LASTEXITCODE -ne 0) {
    throw "$FilePath exited with code $LASTEXITCODE"
  }
}

function Resolve-TrayPython {
  param([string]$ProjectRoot)
  $candidates = @(
    (Join-Path $ProjectRoot "desktop\tray-task-window\.venv\Scripts\python.exe"),
    (Join-Path $ProjectRoot ".venv-tray\Scripts\python.exe")
  )
  foreach ($venvPython in $candidates) {
    if (Test-Path $venvPython) {
      return @{
        FilePath = $venvPython
        Prefix = @()
      }
    }
  }

  $py = Get-Command py.exe -ErrorAction SilentlyContinue
  if ($py) {
    return @{
      FilePath = $py.Source
      Prefix = @("-3")
    }
  }

  $python = Get-Command python.exe -ErrorAction SilentlyContinue
  if ($python) {
    return @{
      FilePath = $python.Source
      Prefix = @()
    }
  }

  return $null
}

function Start-TrayWindow {
  param(
    [string]$ProjectRoot,
    [string]$ManagerUrl,
    [string]$LauncherLog,
    [string]$TrayOutLog,
    [string]$TrayErrLog,
    [switch]$OwnsManager
  )

  $existingTray = Get-ExistingTrayProcesses -ProjectRoot $ProjectRoot
  $existingTray = Stop-DuplicateTrayProcesses -TrayProcesses $existingTray -LauncherLog $LauncherLog
  if ($existingTray.Count -gt 0) {
    $pids = ($existingTray | ForEach-Object { $_.ProcessId }) -join ", "
    $message = "Qt tray task panel is already running. Reusing existing process group root pid(s): $pids"
    Write-Info $message
    Add-Content -LiteralPath $LauncherLog -Encoding UTF8 -Value "[$(Get-Date -Format o)] $message"
    return $existingTray[0]
  }

  $python = Resolve-TrayPython -ProjectRoot $ProjectRoot
  if (-not $python) {
    $message = "Python was not found; skipping Qt tray task panel. Manager/WebGUI remain available."
    Write-Info $message
    Add-Content -LiteralPath $LauncherLog -Encoding UTF8 -Value "[$(Get-Date -Format o)] $message"
    return $null
  }

  $trayMain = Join-Path $ProjectRoot "desktop\tray-task-window\main.py"
  if (-not (Test-Path $trayMain)) {
    $message = "Tray entry was not found at $trayMain; skipping Qt tray task panel."
    Write-Info $message
    Add-Content -LiteralPath $LauncherLog -Encoding UTF8 -Value "[$(Get-Date -Format o)] $message"
    return $null
  }

  $arguments = @()
  $arguments += $python.Prefix
  $arguments += @($trayMain, "--manager-url", $ManagerUrl)
  if ($OwnsManager) {
    $arguments += "--owns-manager"
  }

  Write-Info "Starting Qt tray task panel..."
  Add-Content -LiteralPath $LauncherLog -Encoding UTF8 -Value "[$(Get-Date -Format o)] Starting tray: $($python.FilePath) $($arguments -join ' ')"
  $tray = Start-Process `
    -FilePath $python.FilePath `
    -ArgumentList $arguments `
    -WorkingDirectory $ProjectRoot `
    -RedirectStandardOutput $TrayOutLog `
    -RedirectStandardError $TrayErrLog `
    -WindowStyle Hidden `
    -PassThru
  Write-Info "Qt tray task panel process started: pid=$($tray.Id)"
  Add-Content -LiteralPath $LauncherLog -Encoding UTF8 -Value "[$(Get-Date -Format o)] Tray pid=$($tray.Id), ownsManager=$($OwnsManager.IsPresent)"
  return $tray
}

function Test-NeedsBuild {
  param(
    [string]$ProjectRoot,
    [string]$DistManager
  )
  if (-not (Test-Path $DistManager)) {
    return $true
  }

  $distTime = (Get-Item $DistManager).LastWriteTimeUtc
  $sourceRoots = @(
    (Join-Path $ProjectRoot "src"),
    (Join-Path $ProjectRoot "ribiwebgui\src")
  )
  foreach ($sourceRoot in $sourceRoots) {
    if (-not (Test-Path $sourceRoot)) {
      continue
    }
    $newerSource = Get-ChildItem -Path $sourceRoot -Recurse -File -Include *.ts,*.tsx,*.vue -ErrorAction SilentlyContinue |
      Where-Object { $_.LastWriteTimeUtc -gt $distTime } |
      Select-Object -First 1
    if ($newerSource) {
      return $true
    }
  }
  return $false
}

try {
  $scriptPath = if ($PSCommandPath) { $PSCommandPath } else { $MyInvocation.MyCommand.Path }
  $projectRoot = Resolve-Path (Split-Path -Parent $scriptPath)
  Set-Location $projectRoot

  $logsDir = Join-Path $projectRoot "data\route\$DefaultRouteName\logs"
  New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $launcherLog = Join-Path $logsDir "launcher-$stamp.log"
  $managerOutLog = Join-Path $logsDir "manager-$stamp.stdout.log"
  $managerErrLog = Join-Path $logsDir "manager-$stamp.stderr.log"
  $trayOutLog = Join-Path $logsDir "tray-$stamp.stdout.log"
  $trayErrLog = Join-Path $logsDir "tray-$stamp.stderr.log"

  Add-Content -LiteralPath $launcherLog -Encoding UTF8 -Value "[$(Get-Date -Format o)] RabiRoute Windows launcher"
  Add-Content -LiteralPath $launcherLog -Encoding UTF8 -Value "ProjectRoot=$projectRoot"
  Add-Content -LiteralPath $launcherLog -Encoding UTF8 -Value "ManagerUrl=$ManagerUrl"

  Write-Info "Project: $projectRoot"
  Write-Info "Logs: $logsDir"

  $manager = Test-Manager -Url $ManagerUrl
  if ($manager) {
    Write-Info "Manager is already running at $ManagerUrl. Reusing it."
    Add-Content -LiteralPath $launcherLog -Encoding UTF8 -Value "[$(Get-Date -Format o)] Manager already running."
    if (-not $NoTray) {
      Start-TrayWindow `
        -ProjectRoot $projectRoot `
        -ManagerUrl $ManagerUrl `
        -LauncherLog $launcherLog `
        -TrayOutLog $trayOutLog `
        -TrayErrLog $trayErrLog | Out-Null
    }
    if (-not $NoOpen) {
      Start-Process $ManagerUrl
    }
    Wait-ForEnter
    exit 0
  }

  $uri = [Uri]$ManagerUrl
  $managerPort = [int]$uri.Port
  if (Test-TcpPort -HostName $uri.Host -Port $managerPort) {
    $message = "Port $managerPort is already occupied, but $ManagerUrl/meta did not respond as RabiRoute manager. Not starting a duplicate process."
    Write-Info $message
    Add-Content -LiteralPath $launcherLog -Encoding UTF8 -Value "[$(Get-Date -Format o)] $message"
    Wait-ForEnter
    exit 2
  }

  $distManager = Join-Path $projectRoot "dist\manager.js"
  if (Test-NeedsBuild -ProjectRoot $projectRoot -DistManager $distManager) {
    if ($NoBuild) {
      throw "dist\manager.js is missing or older than source files. Run npm.cmd run build first, or rerun without -NoBuild."
    }
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) {
      throw "npm.cmd was not found. Install Node.js/npm or build RabiRoute before using this launcher."
    }
    Write-Info "dist\manager.js is missing or stale; running npm.cmd run build."
    Invoke-LoggedCommand -FilePath $npm.Source -Arguments @("run", "build") -LogPath $launcherLog -WorkingDirectory $projectRoot
  }

  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $node) {
    throw "node.exe was not found. Install Node.js or run from an environment that has Node on PATH."
  }

  Write-Info "Starting manager in background..."
  Add-Content -LiteralPath $launcherLog -Encoding UTF8 -Value "[$(Get-Date -Format o)] Starting $($node.Source) $distManager"
  $process = Start-Process `
    -FilePath $node.Source `
    -ArgumentList @($distManager) `
    -WorkingDirectory $projectRoot `
    -RedirectStandardOutput $managerOutLog `
    -RedirectStandardError $managerErrLog `
    -WindowStyle Hidden `
    -PassThru
  Write-Info "Manager process started: pid=$($process.Id)"
  Add-Content -LiteralPath $launcherLog -Encoding UTF8 -Value "[$(Get-Date -Format o)] Manager pid=$($process.Id)"

  $manager = $null
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    $manager = Test-Manager -Url $ManagerUrl
    if ($manager) {
      break
    }
  }

  if (-not $manager) {
    Write-Info "Manager did not answer within 15 seconds. Check:"
    Write-Info "  $managerOutLog"
    Write-Info "  $managerErrLog"
    Wait-ForEnter
    exit 3
  }

  Write-Info "Manager is ready at $ManagerUrl."
  try {
    $gatewayPayload = Invoke-RestMethod -Uri "$ManagerUrl/gateways" -Method Get -TimeoutSec 3
    $runningCount = @($gatewayPayload.data.manager | Where-Object { $_.running }).Count
    Write-Info "Gateway rows online: $runningCount"
    Add-Content -LiteralPath $launcherLog -Encoding UTF8 -Value "[$(Get-Date -Format o)] Gateway rows online: $runningCount"
  } catch {
    Write-Info "Manager answered, but gateway status fetch failed: $($_.Exception.Message)"
    Add-Content -LiteralPath $launcherLog -Encoding UTF8 -Value "[$(Get-Date -Format o)] Gateway status fetch failed: $($_.Exception.Message)"
  }

  if (-not $NoOpen) {
    Start-Process $ManagerUrl
  }

  if (-not $NoTray) {
    Start-TrayWindow `
      -ProjectRoot $projectRoot `
      -ManagerUrl $ManagerUrl `
      -LauncherLog $launcherLog `
      -TrayOutLog $trayOutLog `
      -TrayErrLog $trayErrLog `
      -OwnsManager | Out-Null
  }

  Wait-ForEnter
  exit 0
} catch {
  Write-Info "Startup failed: $($_.Exception.Message)"
  try {
    if ($launcherLog) {
      Add-Content -LiteralPath $launcherLog -Encoding UTF8 -Value "[$(Get-Date -Format o)] ERROR $($_.Exception.Message)"
    }
  } catch {
  }
  Wait-ForEnter
  exit 1
}