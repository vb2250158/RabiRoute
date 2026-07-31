param(
  [string]$TaskName = "RabiRouteHealthWatchdog",
  [string]$ManagerUrl = "http://127.0.0.1:8790",
  [string]$DefaultRouteName = "default-main",
  [int]$IntervalMinutes = 1,
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"

if ($IntervalMinutes -lt 1 -or $IntervalMinutes -gt 60) {
  throw "IntervalMinutes must be between 1 and 60."
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$watchdog = Join-Path $projectRoot "scripts\watch-rabiroute-health.ps1"
if (-not (Test-Path -LiteralPath $watchdog)) {
  throw "Health watchdog script was not found: $watchdog"
}

$logsDir = Join-Path $projectRoot "data\route\$DefaultRouteName\logs"
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  $backupPath = Join-Path $logsDir ("scheduled-task-{0}-{1}.xml" -f $TaskName, (Get-Date -Format "yyyyMMdd-HHmmss"))
  Export-ScheduledTask -TaskName $TaskName | Set-Content -LiteralPath $backupPath -Encoding UTF8
  if ($existing.State -eq "Running") {
    Stop-ScheduledTask -TaskName $TaskName
    $deadline = (Get-Date).AddSeconds(10)
    do {
      Start-Sleep -Milliseconds 250
      $existing = Get-ScheduledTask -TaskName $TaskName
    } while ($existing.State -eq "Running" -and (Get-Date) -lt $deadline)
    if ($existing.State -eq "Running") {
      throw "The existing watchdog task did not stop within 10 seconds."
    }
  }
}

$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
$arguments = @(
  "-NoProfile",
  "-WindowStyle Hidden",
  "-ExecutionPolicy Bypass",
  "-File `"$watchdog`"",
  "-ManagerUrl `"$ManagerUrl`"",
  "-DefaultRouteName `"$DefaultRouteName`"",
  "-Once",
  "-NoTrayRepair"
) -join " "
$action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $projectRoot
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$repetitionTrigger = New-ScheduledTaskTrigger `
  -Once `
  -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger @($logonTrigger, $repetitionTrigger) `
  -Settings $settings `
  -User $currentUser `
  -Description "RabiRoute Manager and message-adapter health recovery. Runs one guarded cycle per trigger." `
  -Force | Out-Null

if (-not $NoStart) {
  Start-ScheduledTask -TaskName $TaskName
}

$task = Get-ScheduledTask -TaskName $TaskName
$info = $task | Get-ScheduledTaskInfo
[pscustomobject]@{
  TaskName = $TaskName
  State = [string]$task.State
  TriggerCount = @($task.Triggers).Count
  NextRunTime = $info.NextRunTime
  LastRunTime = $info.LastRunTime
  LastTaskResult = $info.LastTaskResult
  Action = $task.Actions.Execute
  Arguments = $task.Actions.Arguments
}
