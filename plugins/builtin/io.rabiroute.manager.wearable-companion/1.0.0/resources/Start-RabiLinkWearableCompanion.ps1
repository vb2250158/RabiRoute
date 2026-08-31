[CmdletBinding()]
param(
    [string]$Serial = "",
    [Parameter(Mandatory)][string]$ManagerUrl,
    [Parameter(Mandatory)][string]$ApplicationGenerationId,
    [Parameter(Mandatory)][string]$ManagerInstanceId,
    [Parameter(Mandatory)][string]$RuntimeRoot,
    [Parameter(Mandatory)][string]$StateRoot,
    [Parameter(Mandatory)][string]$LogRoot,
    [string]$RoleId = "YeYu",
    [int]$RetrySeconds = 60
)

$ErrorActionPreference = "Stop"
$syncScript = Join-Path $PSScriptRoot "Sync-MiHealthWearableToRabiLink.ps1"
$runtime = [IO.Path]::GetFullPath($RuntimeRoot)
$state = [IO.Path]::GetFullPath($StateRoot)
$logs = [IO.Path]::GetFullPath($LogRoot)
foreach ($candidate in @($runtime, $state, $logs)) {
    if ($candidate.StartsWith("\\")) { throw "Wearable companion runtime paths must be on a local disk." }
    try { $driveType = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($candidate)).DriveType } catch {
        throw "Wearable companion runtime drive type could not be verified as local."
    }
    if ($driveType -eq [IO.DriveType]::Network) {
        throw "Wearable companion runtime paths must not use a mapped network drive."
    }
}
New-Item -ItemType Directory -Path $state -Force | Out-Null
New-Item -ItemType Directory -Path $logs -Force | Out-Null
$logPath = Join-Path $logs "wearable-companion.log.jsonl"
$statePath = Join-Path $state "state.json"

function Write-CompanionLog {
    param([Parameter(Mandatory)][string]$Event, [string]$Message = "", [hashtable]$Data = @{})
    $safeMessage = $Message -replace '(?i)(token|auth.?key|encrypt.?key)\s*[=:]\s*\S+', '$1=[redacted]'
    $entry = [ordered]@{
        time = [DateTimeOffset]::Now.ToString("o")
        event = $Event
        message = $safeMessage.Substring(0, [Math]::Min(300, $safeMessage.Length))
        data = $Data
    }
    Add-Content -LiteralPath $logPath -Value ($entry | ConvertTo-Json -Depth 5 -Compress) -Encoding UTF8
}

function Write-CompanionState {
    param([Parameter(Mandatory)][string]$Status, [string]$Reason = "")
    $payload = [ordered]@{
        schemaVersion = 1
        status = $Status
        reason = $Reason.Substring(0, [Math]::Min(300, $Reason.Length))
        applicationGenerationId = $ApplicationGenerationId
        managerInstanceId = $ManagerInstanceId
        updatedAt = [DateTimeOffset]::Now.ToString("o")
    }
    $temporary = "$statePath.$PID.tmp"
    [IO.File]::WriteAllText($temporary, (($payload | ConvertTo-Json -Depth 4) + "`n"), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $statePath -Force
}

function Test-CleanUnavailable([string]$Message) {
    return $Message -match '尚未启用持续健康记录|采集来源不是|没有找到 adb|读取 RabiLink 移动端设置失败|no devices/emulators found|device .* not found'
}

$retry = [Math]::Max(60, $RetrySeconds)
Write-CompanionState -Status "starting"
Write-CompanionLog -Event "companion_started" -Data @{
    roleId = $RoleId
    retrySeconds = $retry
    applicationGenerationId = $ApplicationGenerationId
    managerInstanceId = $ManagerInstanceId
}

while ($true) {
    $nextDelaySeconds = $retry
    try {
        $arguments = @{
            ManagerUrl = $ManagerUrl
            ApplicationGenerationId = $ApplicationGenerationId
            ManagerInstanceId = $ManagerInstanceId
            RoleId = $RoleId
            Transport = "Manager"
            UseMobileSettings = $true
            DeliverAlerts = $true
            Execute = $true
        }
        if (-not [string]::IsNullOrWhiteSpace($Serial)) { $arguments.Serial = $Serial }
        & $syncScript @arguments | ForEach-Object {
            Write-CompanionState -Status "running"
            Write-CompanionLog -Event "health_batch_published" -Data @{
                transport = $_.Transport
                status = $_.Status
                acceptedCount = $_.AcceptedCount
                deduplicatedCount = $_.DeduplicatedCount
                alertCount = $_.AlertCount
                agentDeliveryCount = $_.AgentDeliveryCount
                heartRateSampleCount = $_.HeartRateSampleCount
                sleepSessionCount = $_.SleepSessionCount
                sleepStageCount = $_.SleepStageCount
                sleepStateCount = $_.SleepStateCount
            }
            if ($_.PollSeconds -ge 60) { $nextDelaySeconds = [int]$_.PollSeconds }
        }
    } catch {
        $message = if ([string]::IsNullOrWhiteSpace($_.Exception.Message)) { "未知错误" } else { $_.Exception.Message }
        if (Test-CleanUnavailable $message) {
            Write-CompanionState -Status "degraded" -Reason $message
            Write-CompanionLog -Event "companion_unavailable" -Message $message
            $nextDelaySeconds = [Math]::Max(60, $retry)
        } elseif ($message -match 'identity|generation|Manager.*不可用|fenced') {
            Write-CompanionState -Status "stale" -Reason $message
            Write-CompanionLog -Event "manager_lease_lost" -Message $message
            exit 21
        } else {
            Write-CompanionState -Status "retrying" -Reason $message
            Write-CompanionLog -Event "sync_iteration_error" -Message $message -Data @{ retrySeconds = $nextDelaySeconds }
        }
    }
    Start-Sleep -Seconds $nextDelaySeconds
}
