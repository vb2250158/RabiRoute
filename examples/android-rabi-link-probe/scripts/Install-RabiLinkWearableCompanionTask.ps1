[CmdletBinding()]
param(
    [string]$TaskName = "RabiLinkWearableHealthCompanion",
    [string]$ManagerUrl = $(if ($env:RABIROUTE_MANAGER_URL) { $env:RABIROUTE_MANAGER_URL } else { "http://127.0.0.1:8790" }),
    [string]$RoleId = "YeYu",
    [switch]$StartNow,
    [switch]$Uninstall,
    [switch]$Execute
)

$ErrorActionPreference = "Stop"
$runner = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "Start-RabiLinkWearableCompanion.ps1")).Path
$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source

if (-not $Execute) {
    [pscustomobject]@{
        Mode = "dry-run"
        TaskName = $TaskName
        Action = if ($Uninstall) { "uninstall" } else { "install" }
        StartNow = [bool]$StartNow
        Runner = $runner
        Note = "传入 -Execute 才会修改 Windows 计划任务。"
    }
    return
}

if ($Uninstall) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
    [pscustomobject]@{ TaskName = $TaskName; Installed = $false; Removed = [bool]$existing }
    return
}

$escapedRunner = $runner.Replace('"', '\"')
$escapedManager = $ManagerUrl.Replace('"', '\"')
$escapedRole = $RoleId.Replace('"', '\"')
$arguments = "-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$escapedRunner`" -ManagerUrl `"$escapedManager`" -RoleId `"$escapedRole`""
$action = New-ScheduledTaskAction -Execute $pwsh -Argument $arguments -WorkingDirectory (Split-Path -Parent $runner)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 5 `
    -RestartInterval (New-TimeSpan -Minutes 1)
$task = Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "RabiLink 小米手表/手环健康 ADB Companion；配置真源在手机端。" `
    -Force
if ($StartNow) { Start-ScheduledTask -TaskName $TaskName }

[pscustomobject]@{
    TaskName = $task.TaskName
    Installed = $true
    Started = [bool]$StartNow
    State = (Get-ScheduledTask -TaskName $TaskName).State.ToString()
}
