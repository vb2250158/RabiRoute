[CmdletBinding()]
param(
    [string]$Serial = "",
    [string]$ManagerUrl = $(if ($env:RABIROUTE_MANAGER_URL) { $env:RABIROUTE_MANAGER_URL } else { "http://127.0.0.1:8790" }),
    [string]$RoleId = "YeYu",
    [int]$RetrySeconds = 30
)

$ErrorActionPreference = "Stop"
$syncScript = Join-Path $PSScriptRoot "Sync-MiHealthWearableToRabiLink.ps1"
$privateDir = Join-Path $PSScriptRoot "..\out\private"
$logPath = Join-Path $privateDir "wearable-companion.log.jsonl"
New-Item -ItemType Directory -Path $privateDir -Force | Out-Null

function Write-CompanionLog {
    param(
        [Parameter(Mandatory)][string]$Event,
        [string]$Message = "",
        [hashtable]$Data = @{}
    )

    $safeMessage = $Message -replace '(?i)(token|auth.?key|encrypt.?key)\s*[=:]\s*\S+', '$1=[redacted]'
    $entry = [ordered]@{
        time = [DateTimeOffset]::Now.ToString("o")
        event = $Event
        message = $safeMessage.Substring(0, [Math]::Min(300, $safeMessage.Length))
        data = $Data
    }
    Add-Content -LiteralPath $logPath -Value ($entry | ConvertTo-Json -Depth 5 -Compress) -Encoding UTF8
}

Write-CompanionLog -Event "companion_started" -Data @{ roleId = $RoleId; retrySeconds = [Math]::Max(15, $RetrySeconds) }

while ($true) {
    $nextDelaySeconds = [Math]::Max(15, $RetrySeconds)
    try {
        $arguments = @{
            ManagerUrl = $ManagerUrl
            RoleId = $RoleId
            Transport = "Manager"
            UseMobileSettings = $true
            DeliverAlerts = $true
            Execute = $true
        }
        if (-not [string]::IsNullOrWhiteSpace($Serial)) { $arguments.Serial = $Serial }
        & $syncScript @arguments | ForEach-Object {
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
            if ($_.PollSeconds -ge 15) {
                $nextDelaySeconds = [int]$_.PollSeconds
            }
        }
    } catch {
        $message = if ([string]::IsNullOrWhiteSpace($_.Exception.Message)) { "未知错误" } else { $_.Exception.Message }
        Write-CompanionLog -Event "sync_iteration_error" -Message $message -Data @{ retrySeconds = $nextDelaySeconds }
    }
    Start-Sleep -Seconds $nextDelaySeconds
}
