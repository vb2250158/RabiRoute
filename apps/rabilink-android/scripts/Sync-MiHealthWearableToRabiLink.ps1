[CmdletBinding()]
param(
    [string]$Serial = "",
    [string]$RelayUrl = $env:RABILINK_RELAY_URL,
    [string]$AppToken = $env:RABILINK_RELAY_APP_TOKEN,
    [string]$RabiRouteConfigPath = "",
    [ValidateSet("Auto", "Relay", "Manager")]
    [string]$Transport = "Auto",
    [string]$ManagerUrl = $(if ($env:RABIROUTE_MANAGER_URL) { $env:RABIROUTE_MANAGER_URL } else { "http://127.0.0.1:8790" }),
    [string]$RoleId = "YeYu",
    [bool]$DeliverAlerts = $true,
    [bool]$UseMobileSettings = $true,
    [string]$SourceDeviceId = "xiaomi-wearable-adb",
    [string]$SourceDeviceName = "小米手表/手环",
    [string]$SourceDeviceKind = "xiaomi-wearable",
    [int]$HeartRateHighBpm = 120,
    [int]$HeartRateLowBpm = 0,
    [int]$AlertCooldownMinutes = 15,
    [switch]$SleepStateAlertEnabled,
    [int]$PollSeconds = 60,
    [switch]$Continuous,
    [switch]$Execute
)

$ErrorActionPreference = "Stop"
$script:PollSecondsWasExplicit = $PSBoundParameters.ContainsKey("PollSeconds")

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..\..")).Path
$probeModule = Join-Path $PSScriptRoot "MiHealthProbe.psm1"
if ([string]::IsNullOrWhiteSpace($RabiRouteConfigPath)) {
    $RabiRouteConfigPath = Join-Path $projectRoot "data\Config.json"
}

function Resolve-RelaySettings {
    $url = $RelayUrl.Trim()
    $token = $AppToken.Trim()
    if (([string]::IsNullOrWhiteSpace($url) -or [string]::IsNullOrWhiteSpace($token)) -and
        (Test-Path -LiteralPath $RabiRouteConfigPath)) {
        $config = Get-Content -LiteralPath $RabiRouteConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([string]::IsNullOrWhiteSpace($url)) {
            $url = [string]$config.rabiLinkRelay.url
        }
        if ([string]::IsNullOrWhiteSpace($token)) {
            $token = [string]$config.rabiLinkRelay.token
        }
    }
    if ([string]::IsNullOrWhiteSpace($url)) {
        throw "RabiLink Relay 地址未配置。请在 RabiLink 设置中配置，或传入 -RelayUrl。"
    }
    if ([string]::IsNullOrWhiteSpace($token)) {
        throw "RabiLink 应用 token 未配置。请在 RabiLink 设置中配置，或通过安全环境变量 RABILINK_RELAY_APP_TOKEN 提供。"
    }
    return [pscustomobject]@{
        Url = $url.TrimEnd("/")
        Token = $token
    }
}

function Resolve-AdbCommand {
    $command = Get-Command adb -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $mumuAdb = Join-Path $env:ProgramFiles "Netease\MuMu\nx_main\adb.exe"
    if (Test-Path -LiteralPath $mumuAdb -PathType Leaf) { return $mumuAdb }
    throw "没有找到 adb。请重新打开 PowerShell，或确认 Android platform-tools 已加入 PATH。"
}

function Invoke-RabiLinkMobileAdb {
    param([Parameter(Mandatory)][string[]]$Arguments)

    $adb = Resolve-AdbCommand
    $prefix = @()
    if (-not [string]::IsNullOrWhiteSpace($Serial)) { $prefix = @("-s", $Serial) }
    $output = & $adb @prefix @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "读取 RabiLink 移动端设置失败；请确认手机已连接、USB 调试已授权且 APK 可用。"
    }
    return ($output -join "`n")
}

function Get-RabiLinkMobileWearableSettings {
    $encodedOutput = Invoke-RabiLinkMobileAdb -Arguments @(
        "exec-out", "run-as", "com.rabi.link", "base64",
        "shared_prefs/rabilink_wearable_health.xml"
    )
    $base64Lines = @($encodedOutput -split "\r?\n" | Where-Object {
        $_.Length -ge 20 -and $_ -match '^[A-Za-z0-9+/=]+$'
    })
    try {
        $raw = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($base64Lines -join "")))
    } catch {
        throw "RabiLink 移动端健康设置格式无效。"
    }
    $xmlStart = $raw.IndexOf("<?xml", [StringComparison]::Ordinal)
    if ($xmlStart -lt 0) { $xmlStart = $raw.IndexOf("<map", [StringComparison]::Ordinal) }
    $xmlEnd = $raw.LastIndexOf("</map>", [StringComparison]::Ordinal)
    if ($xmlStart -lt 0 -or $xmlEnd -lt $xmlStart) { throw "RabiLink 移动端健康设置格式无效。" }
    $xmlText = $raw.Substring($xmlStart, $xmlEnd + 6 - $xmlStart)
    try { [xml]$document = $xmlText } catch { throw "RabiLink 移动端健康设置格式无效。" }
    $values = @{}
    foreach ($node in @($document.map.ChildNodes)) {
        if ($node.NodeType -ne [System.Xml.XmlNodeType]::Element) { continue }
        $name = [string]$node.GetAttribute("name")
        if ([string]::IsNullOrWhiteSpace($name)) { continue }
        $values[$name] = if ($node.LocalName -eq "string") { [string]$node.InnerText } else { [string]$node.GetAttribute("value") }
    }
    $enabledValue = $false
    [bool]::TryParse([string]$values.enabled, [ref]$enabledValue) | Out-Null
    $sleepAlertValue = $false
    [bool]::TryParse([string]$values.sleepStateAlertEnabled, [ref]$sleepAlertValue) | Out-Null
    return [pscustomobject]@{
        Enabled = $enabledValue
        CollectorMode = if ($values.collectorMode) { [string]$values.collectorMode } else { "health_connect" }
        SourceDeviceId = [string]$values.sourceDeviceId
        SourceDeviceName = [string]$values.sourceDeviceName
        SourceDeviceKind = [string]$values.sourceDeviceKind
        PollIntervalMinutes = if ($values.pollIntervalMinutes) { [int]$values.pollIntervalMinutes } else { 5 }
        HeartRateHighBpm = if ($values.heartRateHighBpm) { [int]$values.heartRateHighBpm } else { 120 }
        HeartRateLowBpm = if ($values.heartRateLowBpm) { [int]$values.heartRateLowBpm } else { 0 }
        AlertCooldownMinutes = if ($values.heartRateAlertCooldownMinutes) { [int]$values.heartRateAlertCooldownMinutes } else { 15 }
        SleepStateAlertEnabled = $sleepAlertValue
    }
}

function Apply-RabiLinkMobileWearableSettings {
    param([Parameter(Mandatory)]$Settings)

    if (-not $Settings.Enabled) {
        throw "RabiLink 移动端尚未启用持续健康记录。"
    }
    if ($Settings.CollectorMode -ne "xiaomi_adb_companion") {
        throw 'RabiLink 移动端采集来源不是“小米运动健康（PC ADB Companion）”。'
    }
    if (-not [string]::IsNullOrWhiteSpace($Settings.SourceDeviceId)) { $script:SourceDeviceId = $Settings.SourceDeviceId.Trim() }
    if (-not [string]::IsNullOrWhiteSpace($Settings.SourceDeviceName)) { $script:SourceDeviceName = $Settings.SourceDeviceName.Trim() }
    if (-not [string]::IsNullOrWhiteSpace($Settings.SourceDeviceKind)) { $script:SourceDeviceKind = $Settings.SourceDeviceKind.Trim() }
    $script:HeartRateHighBpm = $Settings.HeartRateHighBpm
    $script:HeartRateLowBpm = $Settings.HeartRateLowBpm
    $script:AlertCooldownMinutes = $Settings.AlertCooldownMinutes
    $script:SleepStateAlertEnabled = [bool]$Settings.SleepStateAlertEnabled
    if (-not $script:PollSecondsWasExplicit) {
        $script:PollSeconds = [Math]::Max(60, $Settings.PollIntervalMinutes * 60)
    }
}

function Resolve-PublishTarget {
    $requested = $Transport.Trim().ToLowerInvariant()
    if ($requested -eq "relay") {
        return [pscustomobject]@{ Kind = "Relay"; Relay = Resolve-RelaySettings; ManagerUrl = "" }
    }
    if ($requested -eq "auto") {
        try {
            $relay = Resolve-RelaySettings
            return [pscustomobject]@{ Kind = "Relay"; Relay = $relay; ManagerUrl = "" }
        } catch {
            # A local Manager is the intentional offline fallback. It records
            # the same role-scoped timeline and can explicitly route alerts.
        }
    }
    $url = $ManagerUrl.Trim().TrimEnd("/")
    if ([string]::IsNullOrWhiteSpace($url)) { throw "RabiRoute Manager 地址未配置。" }
    try {
        $meta = Invoke-RestMethod -Uri "$url/meta" -Method Get -TimeoutSec 5
        if ($null -eq $meta) { throw "empty response" }
    } catch {
        throw "RabiRoute Manager 不可用：$url"
    }
    return [pscustomobject]@{ Kind = "Manager"; Relay = $null; ManagerUrl = $url }
}

function ConvertTo-MiHealthIsoTime {
    param([AllowNull()]$Value)

    $timestamp = 0L
    if ($null -eq $Value -or -not [int64]::TryParse([string]$Value, [ref]$timestamp)) {
        return $null
    }
    if ([Math]::Abs($timestamp) -lt 100000000000L) {
        $timestamp *= 1000L
    }
    try {
        return [DateTimeOffset]::FromUnixTimeMilliseconds($timestamp).ToString("o")
    } catch {
        return $null
    }
}

function ConvertTo-XiaomiSleepStage {
    param([AllowNull()]$Value)

    # Xiaomi sleep report stage_list currently uses 1/2/3/4 for
    # awake/light/deep/REM. Unknown provider codes stay explicit and are not
    # guessed into a clinical sleep stage.
    switch ([string]$Value) {
        "1" { return "awake" }
        "2" { return "light" }
        "3" { return "deep" }
        "4" { return "rem" }
        default { return "unknown" }
    }
}

function New-HeartRateSample {
    param([Parameter(Mandatory)]$HeartRateResult)

    if ($HeartRateResult.status -ne "available" -or $null -eq $HeartRateResult.data) {
        return $null
    }
    $bpm = [int]$HeartRateResult.data.heartRateBpm
    $timestamp = [int64]$HeartRateResult.data.timestampMillis
    $recordedAt = ConvertTo-MiHealthIsoTime $timestamp
    if ([string]::IsNullOrWhiteSpace($recordedAt) -or $bpm -lt 1 -or $bpm -gt 300) {
        return $null
    }
    $sampleId = "xiaomi-provider-heart-$timestamp-$bpm"
    return [pscustomobject]@{
        id = $sampleId
        metric = "heart_rate"
        recordedAt = $recordedAt
        startAt = $recordedAt
        value = $bpm
        unit = "bpm"
        source = "xiaomi-health-adb-provider"
    }
}

function New-SleepSamples {
    param(
        [Parameter(Mandatory)]$SleepReportResult,
        [Parameter(Mandatory)]$SleepStagesResult,
        [DateTimeOffset]$ObservedAt = [DateTimeOffset]::Now
    )

    $samples = [System.Collections.Generic.List[object]]::new()
    $sessions = [System.Collections.Generic.List[object]]::new()
    foreach ($row in @($SleepReportResult.data)) {
        $startAt = ConvertTo-MiHealthIsoTime $row.sleep_time
        $endAt = ConvertTo-MiHealthIsoTime $row.wake_time
        if ([string]::IsNullOrWhiteSpace($startAt) -or [string]::IsNullOrWhiteSpace($endAt)) {
            continue
        }
        $startMillis = [DateTimeOffset]::Parse($startAt).ToUnixTimeMilliseconds()
        $endMillis = [DateTimeOffset]::Parse($endAt).ToUnixTimeMilliseconds()
        if ($endMillis -le $startMillis) {
            continue
        }
        $sessions.Add([pscustomobject]@{ StartAt = $startAt; EndAt = $endAt; StartMillis = $startMillis; EndMillis = $endMillis })
        $samples.Add([ordered]@{
            id = "xiaomi-provider-sleep-session-$startMillis-$endMillis"
            metric = "sleep_session"
            recordedAt = $endAt
            startAt = $startAt
            endAt = $endAt
            source = "xiaomi-health-adb-provider"
        })

        $stageRows = @()
        if (-not [string]::IsNullOrWhiteSpace([string]$row.stage_list)) {
            try { $stageRows = @($row.stage_list | ConvertFrom-Json) } catch { $stageRows = @() }
        }
        foreach ($stageRow in $stageRows) {
            $stageStartAt = ConvertTo-MiHealthIsoTime $stageRow.beginTime
            $stageEndAt = ConvertTo-MiHealthIsoTime $stageRow.endTime
            if ([string]::IsNullOrWhiteSpace($stageStartAt) -or [string]::IsNullOrWhiteSpace($stageEndAt)) {
                continue
            }
            $stageStartMillis = [DateTimeOffset]::Parse($stageStartAt).ToUnixTimeMilliseconds()
            $stageEndMillis = [DateTimeOffset]::Parse($stageEndAt).ToUnixTimeMilliseconds()
            if ($stageEndMillis -le $stageStartMillis) {
                continue
            }
            $rawStage = [string]$stageRow.stage
            $samples.Add([ordered]@{
                id = "xiaomi-provider-sleep-stage-$stageStartMillis-$stageEndMillis-$rawStage"
                metric = "sleep_stage"
                recordedAt = $stageEndAt
                startAt = $stageStartAt
                endAt = $stageEndAt
                sleepStage = ConvertTo-XiaomiSleepStage $rawStage
                source = "xiaomi-health-adb-provider"
                metadata = [ordered]@{ providerStageCode = $rawStage }
            })
        }
    }

    # sleep/record may expose an in-progress interval before sleep/report is
    # finalized. Use it only to decide whether the user is sleeping now; an
    # absent interval is not by itself proof that the user is awake.
    $nowMillis = $ObservedAt.ToUnixTimeMilliseconds()
    $activeStage = @($SleepStagesResult.data | Where-Object {
        $beginMillis = 0L
        $endMillis = 0L
        [int64]::TryParse([string]$_.begin_time, [ref]$beginMillis) -and
        [int64]::TryParse([string]$_.end_time, [ref]$endMillis) -and
        $beginMillis -le $nowMillis -and $endMillis -gt $nowMillis
    } | Select-Object -First 1)
    $currentState = if ($activeStage.Count -gt 0) {
        "sleeping"
    } elseif (@($sessions | Where-Object { $_.EndMillis -le $nowMillis }).Count -gt 0) {
        "awake"
    } else {
        ""
    }
    if (-not [string]::IsNullOrWhiteSpace($currentState)) {
        $stateBucketMillis = [Math]::Max(60000L, [int64]([Math]::Max(15, $PollSeconds) * 1000L))
        $bucket = [Math]::Floor($nowMillis / $stateBucketMillis)
        $observedIso = $ObservedAt.ToString("o")
        $samples.Add([ordered]@{
            id = "xiaomi-provider-sleep-state-$currentState-$bucket"
            metric = "sleep_state"
            recordedAt = $observedIso
            startAt = $observedIso
            sleepState = $currentState
            source = "xiaomi-health-adb-provider"
            metadata = [ordered]@{ inference = if ($currentState -eq "sleeping") { "active-provider-stage" } else { "completed-provider-session" } }
        })
    }

    return @($samples)
}

function New-WearablePayload {
    param(
        [Parameter(Mandatory)]$HeartRateResult,
        [Parameter(Mandatory)]$SleepReportResult,
        [Parameter(Mandatory)]$SleepStagesResult,
        [DateTimeOffset]$ObservedAt = [DateTimeOffset]::Now
    )

    $samples = [System.Collections.Generic.List[object]]::new()
    $heartRateSample = New-HeartRateSample -HeartRateResult $HeartRateResult
    if ($null -ne $heartRateSample) {
        $samples.Add($heartRateSample)
    }
    foreach ($sleepSample in @(New-SleepSamples -SleepReportResult $SleepReportResult -SleepStagesResult $SleepStagesResult -ObservedAt $ObservedAt)) {
        $samples.Add($sleepSample)
    }
    if ($samples.Count -eq 0) {
        throw "小米健康当前没有可同步的心率或睡眠数据。"
    }

    $sampleIds = @($samples | ForEach-Object { [string]$_.id })
    $heartRateCount = @($samples | Where-Object { $_.metric -eq "heart_rate" }).Count
    $sleepSessionCount = @($samples | Where-Object { $_.metric -eq "sleep_session" }).Count
    $sleepStageCount = @($samples | Where-Object { $_.metric -eq "sleep_stage" }).Count
    $sleepStateCount = @($samples | Where-Object { $_.metric -eq "sleep_state" }).Count
    $fingerprint = $sampleIds -join "|"
    return [pscustomobject]@{
        Fingerprint = $fingerprint
        HeartRateBpm = if ($null -ne $heartRateSample) { [int]$heartRateSample.value } else { $null }
        HeartRateRecordedAt = if ($null -ne $heartRateSample) { [string]$heartRateSample.recordedAt } else { $null }
        SleepSessionCount = $sleepSessionCount
        SleepStageCount = $sleepStageCount
        SleepStateCount = $sleepStateCount
        Body = [ordered]@{
            text = "智能手表/手环健康数据 $($samples.Count) 条：心率 $heartRateCount、睡眠会话 $sleepSessionCount、睡眠阶段 $sleepStageCount、睡眠状态 $sleepStateCount"
            type = "wearable.health"
            deliveryMode = "observe"
            source = "rabilink-wearable"
            sourceDeviceId = $SourceDeviceId
            sourceDeviceKind = $SourceDeviceKind
            sourceDeviceName = $SourceDeviceName
            transport = "xiaomi-health-adb-provider"
            clientMessageId = "wearable-health-$([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($fingerprint))).Substring(0, 24).ToLowerInvariant())"
            capturedAt = $ObservedAt.ToUnixTimeMilliseconds()
            health = [ordered]@{
                schemaVersion = 1
                policy = [ordered]@{
                    enabled = $true
                    heartRateHighBpm = [Math]::Min(240, [Math]::Max(40, $HeartRateHighBpm))
                    heartRateLowBpm = [Math]::Min(150, [Math]::Max(0, $HeartRateLowBpm))
                    heartRateAlertCooldownMinutes = [Math]::Min(1440, [Math]::Max(1, $AlertCooldownMinutes))
                    sleepStateAlertEnabled = [bool]$SleepStateAlertEnabled
                    heartRateStaleAfterMinutes = [Math]::Max(2, [Math]::Ceiling($PollSeconds / 60.0) * 3)
                    sleepStateStaleAfterMinutes = 180
                }
                samples = @($samples)
            }
        }
    }
}

function Publish-WearableObservation {
    param(
        [Parameter(Mandatory)]$Observation,
        [Parameter(Mandatory)]$Target
    )

    if ($Target.Kind -eq "Relay") {
        $receipt = Invoke-RestMethod `
            -Uri "$($Target.Relay.Url)/api/rabilink/devices/input" `
            -Method Post `
            -Headers @{ "X-RabiLink-Token" = $Target.Relay.Token } `
            -ContentType "application/json; charset=utf-8" `
            -Body ($Observation.Body | ConvertTo-Json -Depth 10 -Compress)
        return [pscustomobject]@{
            Transport = "Relay"
            Status = if ($receipt.status) { [string]$receipt.status } else { "accepted" }
            EventId = [string]$receipt.eventId
            AcceptedCount = $null
            DeduplicatedCount = $null
            AlertCount = $null
            AgentDeliveryCount = $null
        }
    }

    $encodedRoleId = [Uri]::EscapeDataString($RoleId.Trim())
    $deliver = if ($DeliverAlerts) { "true" } else { "false" }
    $receipt = Invoke-RestMethod `
        -Uri "$($Target.ManagerUrl)/api/roles/$encodedRoleId/health/observations?deliverAlerts=$deliver" `
        -Method Post `
        -ContentType "application/json; charset=utf-8" `
        -Body ($Observation.Body | ConvertTo-Json -Depth 10 -Compress)
    if ($receipt.code -ne 0) { throw "Manager 拒绝了健康观测。" }
    $data = $receipt.data
    $gatewayDeliveries = @($data.delivery.results | ForEach-Object {
        if ($null -ne $_.results) { @($_.results) } else { $_ }
    })
    return [pscustomobject]@{
        Transport = "Manager"
        Status = "accepted"
        EventId = [string]$data.eventId
        AcceptedCount = @($data.accepted).Count
        DeduplicatedCount = @($data.deduplicated).Count
        AlertCount = @($data.alerts).Count
        AgentDeliveryCount = @($gatewayDeliveries | Where-Object { $_.sentPacketCount -gt 0 }).Count
    }
}

if (-not $Execute) {
    [pscustomobject]@{
        Mode = "dry-run"
        WouldReadAdb = $true
        WouldPublishToRabiLink = $true
        Transport = $Transport
        ManagerUrlConfigured = (-not [string]::IsNullOrWhiteSpace($ManagerUrl))
        RoleId = $RoleId
        DeliverAlerts = $DeliverAlerts
        UseMobileSettings = $UseMobileSettings
        Continuous = [bool]$Continuous
        PollSeconds = [Math]::Max(15, $PollSeconds)
        SourceDeviceId = $SourceDeviceId
        HeartRateHighBpm = $HeartRateHighBpm
        HeartRateLowBpm = $HeartRateLowBpm
        WouldReadSleep = $true
        SleepStateAlertEnabled = [bool]$SleepStateAlertEnabled
        Note = "传入 -Execute 才会读取移动端配置、连接 ADB 并上报心率、睡眠会话、睡眠阶段与睡/醒状态；手表认证秘钥不会进入此链路。"
    }
    return
}

Import-Module $probeModule -Force
if ($UseMobileSettings) {
    Apply-RabiLinkMobileWearableSettings -Settings (Get-RabiLinkMobileWearableSettings)
}
$publishTarget = Resolve-PublishTarget
$lastBatchFingerprint = ""

do {
    try {
        if ($UseMobileSettings) {
            Apply-RabiLinkMobileWearableSettings -Settings (Get-RabiLinkMobileWearableSettings)
        }
        $observedAt = [DateTimeOffset]::Now
        $heartRate = Get-MiHealthLatestHeartRate -Serial $Serial
        $sleepReport = Get-MiHealthSleepReport -Serial $Serial -Date $observedAt
        $sleepStages = Get-MiHealthSleepStages -Serial $Serial -Date $observedAt
        $observation = New-WearablePayload `
            -HeartRateResult $heartRate `
            -SleepReportResult $sleepReport `
            -SleepStagesResult $sleepStages `
            -ObservedAt $observedAt
        if ($observation.Fingerprint -eq $lastBatchFingerprint) {
            Write-Verbose "最新心率和睡眠样本未变化。"
        } else {
            $receipt = Publish-WearableObservation -Observation $observation -Target $publishTarget
            $lastBatchFingerprint = $observation.Fingerprint
            [pscustomobject]@{
                Transport = $receipt.Transport
                Status = $receipt.Status
                EventId = $receipt.EventId
                AcceptedCount = $receipt.AcceptedCount
                DeduplicatedCount = $receipt.DeduplicatedCount
                AlertCount = $receipt.AlertCount
                AgentDeliveryCount = $receipt.AgentDeliveryCount
                HeartRateSampleCount = if ($null -ne $observation.HeartRateBpm) { 1 } else { 0 }
                SleepSessionCount = $observation.SleepSessionCount
                SleepStageCount = $observation.SleepStageCount
                SleepStateCount = $observation.SleepStateCount
                PollSeconds = [Math]::Max(15, $PollSeconds)
                SourceDeviceId = $SourceDeviceId
            }
        }
    } catch {
        if (-not $Continuous) { throw }
        Write-Warning "小米健康心率/睡眠同步失败：$($_.Exception.Message)"
    }
    if ($Continuous) {
        Start-Sleep -Seconds ([Math]::Max(15, $PollSeconds))
    }
} while ($Continuous)
