param(
  [string]$ManagerUrl = "http://127.0.0.1:8790",
  [string]$DefaultRouteName = "default-main",
  [int]$IntervalSeconds = 5,
  [int]$FailureThreshold = 2,
  [switch]$Once,
  [switch]$NoRepair
)

$ErrorActionPreference = "Stop"
[System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy

$projectRootInput = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$projectRoot = (Resolve-Path $projectRootInput).Path
$intentPath = Join-Path $projectRoot "data\runtime\desktop-lifecycle-intent.json"
$logsDir = Join-Path $projectRoot "data\route\$DefaultRouteName\logs"
$jsonlPath = Join-Path $logsDir "desktop-lifecycle-supervisor.jsonl"
$textLogPath = Join-Path $logsDir "desktop-lifecycle-supervisor.log"
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null

function Write-LifecycleRecord {
  param(
    [string]$Status,
    [string]$Message,
    $Intent = $null,
    $ManagerConnected = $null,
    $ManagerPresent = $null,
    [int]$ManagerFailureCount = 0,
    [string]$ManagerProbeError = "",
    [int]$DesktopShellCount = -1,
    [bool]$RepairAttempted = $false
  )
  $record = [ordered]@{
    timestamp = (Get-Date).ToUniversalTime().ToString("o")
    status = $Status
    message = $Message
    desiredState = if ($Intent) { [string]$Intent.desiredState } else { $null }
    source = if ($Intent) { [string]$Intent.source } else { $null }
    managerConnected = $ManagerConnected
    managerPresent = $ManagerPresent
    managerFailureCount = $ManagerFailureCount
    managerProbeError = $ManagerProbeError
    desktopShellCount = $DesktopShellCount
    repairAttempted = $RepairAttempted
  }
  Add-Content -LiteralPath $jsonlPath -Encoding UTF8 -Value ($record | ConvertTo-Json -Compress -Depth 4)
  Add-Content -LiteralPath $textLogPath -Encoding UTF8 -Value "[$($record.timestamp)] $Status $Message"
}

function Read-DesktopLifecycleIntent {
  if (-not (Test-Path -LiteralPath $intentPath)) { return $null }
  try {
    $intent = Get-Content -LiteralPath $intentPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($intent.schemaVersion -ne 1) { return $null }
    if ($intent.desiredState -notin @("running", "stopped")) { return $null }
    if (-not $intent.source) { return $null }
    return $intent
  } catch {
    return $null
  }
}

function Test-ManagerConnected {
  try {
    Invoke-RestMethod -Uri "$ManagerUrl/meta" -Method Get -TimeoutSec 3 | Out-Null
    return [pscustomobject]@{
      connected = $true
      error = ""
    }
  } catch {
    $message = [string]$_.Exception.Message
    if ($message.Length -gt 500) { $message = $message.Substring(0, 500) }
    return [pscustomobject]@{
      connected = $false
      error = $message
    }
  }
}

function Get-ProjectManagerProcesses {
  $distManagers = @(
    (Join-Path $projectRoot "dist\manager.js").ToLowerInvariant(),
    (Join-Path $projectRootInput "dist\manager.js").ToLowerInvariant()
  ) | Select-Object -Unique
  $relativePattern = '(^|[\s"])(?:\.\\|\./)?dist[\\/]manager\.js(?=$|[\s"])'
  try {
    return @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
      $commandLine = if ($_.CommandLine) { $_.CommandLine.ToLowerInvariant() } else { "" }
      $_.Name -ieq "node.exe" -and $commandLine -and (
        @($distManagers | Where-Object { $commandLine.Contains($_) }).Count -gt 0 -or
        $commandLine -match $relativePattern
      )
    })
  } catch {
    return @()
  }
}

function Get-DesktopShellProcesses {
  $scriptNeedles = @(
    (Join-Path $projectRoot "desktop\tray-task-window\main.py").ToLowerInvariant(),
    (Join-Path $projectRootInput "desktop\tray-task-window\main.py").ToLowerInvariant()
  ) | Select-Object -Unique
  $packagedPaths = @(
    (Join-Path $projectRoot "RabiRoute-Desktop.exe").ToLowerInvariant(),
    (Join-Path $projectRootInput "RabiRoute-Desktop.exe").ToLowerInvariant()
  ) | Select-Object -Unique
  try {
    return @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
      $commandLine = if ($_.CommandLine) { $_.CommandLine.ToLowerInvariant() } else { "" }
      $executablePath = if ($_.ExecutablePath) { $_.ExecutablePath.ToLowerInvariant() } else { "" }
      @($scriptNeedles | Where-Object { $commandLine.Contains($_) }).Count -gt 0 -or
      $packagedPaths -contains $executablePath
    })
  } catch {
    return @()
  }
}

function Repair-RabiRouteDesktop {
  param($Intent)
  # The launcher verifies an unresponsive port owner before replacing it. The
  # packaged desktop executable can start a missing Manager but cannot take over
  # a live, unresponsive Manager that still owns the instance lock and port.
  $launcher = Join-Path $projectRoot "Start-RabiRoute-Desktop.bat"
  if (-not (Test-Path -LiteralPath $launcher)) {
    throw "Desktop launcher is missing: $launcher"
  }
  & $launcher `
    -ManagerUrl $ManagerUrl `
    -DefaultRouteName $DefaultRouteName `
    -NoOpen `
    -NoBuild `
    -UseExistingBuild `
    -ReuseHealthyManager `
    -NoDesktopSupervisor
  $launcherExitCode = $LASTEXITCODE
  if ($null -ne $launcherExitCode -and $launcherExitCode -ne 0) {
    throw "Desktop launcher exited with code $launcherExitCode"
  }
}

$hashBytes = [System.Security.Cryptography.SHA256]::Create().ComputeHash(
  [System.Text.Encoding]::UTF8.GetBytes($projectRoot.ToLowerInvariant())
)
$hash = ([BitConverter]::ToString($hashBytes)).Replace("-", "").Substring(0, 20)
$mutex = New-Object System.Threading.Mutex($false, "Local\RabiRouteDesktopLifecycle-$hash")
$ownsMutex = $false
try {
  try { $ownsMutex = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $ownsMutex = $true }
  if (-not $ownsMutex) { exit 0 }

  $managerFailures = 0
  $trayFailures = 0
  do {
    $intent = Read-DesktopLifecycleIntent
    if (-not $intent) {
      Write-LifecycleRecord -Status "stopped" -Message "No valid running intent; supervisor is failing closed."
      exit 0
    }
    if ([string]$intent.desiredState -ne "running") {
      Write-LifecycleRecord -Status "stopped" -Message "Desktop exit intent observed; supervisor is stopping." -Intent $intent
      exit 0
    }

    $managerProbe = Test-ManagerConnected
    $managerConnected = [bool]$managerProbe.connected
    $managerProbeError = [string]$managerProbe.error
    $managerPresent = $managerConnected -or @(Get-ProjectManagerProcesses).Count -gt 0
    $desktopShellCount = @(Get-DesktopShellProcesses).Count
    # A surviving node process is only ownership evidence. Recovery must follow
    # the Manager API because the tray cannot work while /meta is unavailable.
    $managerFailures = if ($managerConnected) { 0 } else { $managerFailures + 1 }
    $trayFailures = if ($desktopShellCount -gt 0) { 0 } else { $trayFailures + 1 }
    $repairNeeded = $managerFailures -ge [Math]::Max(1, $FailureThreshold) -or $trayFailures -ge [Math]::Max(1, $FailureThreshold)
    $repairAttempted = $false
    $repairError = $null

    if ($repairNeeded -and -not $NoRepair) {
      $repairAttempted = $true
      try {
        Repair-RabiRouteDesktop -Intent $intent
      } catch {
        $repairError = $_.Exception.Message
      }
      Start-Sleep -Milliseconds 750
      $managerProbe = Test-ManagerConnected
      $managerConnected = [bool]$managerProbe.connected
      $managerProbeError = [string]$managerProbe.error
      $managerPresent = $managerConnected -or @(Get-ProjectManagerProcesses).Count -gt 0
      $desktopShellCount = @(Get-DesktopShellProcesses).Count
      $managerFailures = if ($managerConnected) { 0 } else { $managerFailures }
      $trayFailures = if ($desktopShellCount -gt 0) { 0 } else { $trayFailures }
      if ($managerConnected) {
        $repairError = $null
      }
    }

    $healthy = $managerConnected -and $desktopShellCount -gt 0
    $status = if ($healthy) { "ok" } elseif ($repairError) { "error" } else { "degraded" }
    $message = if ($repairError) {
      "Desktop pair repair failed: $repairError"
    } elseif ($healthy -and $repairAttempted) {
      "Manager and tray were repaired and read back healthy."
    } elseif ($healthy) {
      "Manager and tray are associated and healthy."
    } elseif ($managerPresent -and $desktopShellCount -gt 0) {
      "Manager process and desktop shell are present, but /meta is unavailable."
    } else {
      "Manager/tray pair is incomplete; waiting for the bounded failure threshold or repair verification."
    }
    Write-LifecycleRecord `
      -Status $status `
      -Message $message `
      -Intent $intent `
      -ManagerConnected $managerConnected `
      -ManagerPresent $managerPresent `
      -ManagerFailureCount $managerFailures `
      -ManagerProbeError $managerProbeError `
      -DesktopShellCount $desktopShellCount `
      -RepairAttempted $repairAttempted

    if (-not $Once) { Start-Sleep -Seconds ([Math]::Max(1, $IntervalSeconds)) }
  } while (-not $Once)
} finally {
  if ($ownsMutex) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
