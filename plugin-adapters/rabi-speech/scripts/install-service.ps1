param(
  [string]$TaskName = "RabiSpeech",
  [switch]$StartNow
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$startScript = Join-Path $PSScriptRoot "start.ps1"
if (!(Test-Path -LiteralPath $startScript)) {
  throw "RabiSpeech start script is missing: $startScript"
}

function Convert-ToUnc([string]$PathValue) {
  $full = [IO.Path]::GetFullPath($PathValue)
  if ($full.StartsWith("\\")) { return $full }
  $driveRoot = [IO.Path]::GetPathRoot($full)
  $drive = Get-PSDrive -Name $driveRoot.TrimEnd("\").TrimEnd(":") -ErrorAction SilentlyContinue
  if (!$drive -or !$drive.DisplayRoot) { return $full }
  return Join-Path $drive.DisplayRoot $full.Substring($driveRoot.Length).TrimStart("\")
}

$root = Convert-ToUnc $root
$startScript = Convert-ToUnc $startScript
$arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $startScript
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Description "Rabi local-only TTS/ASR provider service" -Force | Out-Null

if ($StartNow) {
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:8781/health" -TimeoutSec 3
  } catch {
    $health = $null
  }
  if (!$health.ok) {
    Start-ScheduledTask -TaskName $TaskName
  }
}

$task = Get-ScheduledTask -TaskName $TaskName
[pscustomobject]@{
  TaskName = $task.TaskName
  State = [string]$task.State
  Trigger = "AtLogOn"
  StartScript = $startScript
  LocalUrl = "http://127.0.0.1:8781"
} | Format-List
