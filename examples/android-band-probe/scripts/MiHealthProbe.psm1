$ErrorActionPreference = "Stop"

$script:ProviderRoot = "content://com.mi.health.provider.main"
$script:BridgeJarDevicePath = "/data/local/tmp/mihealth-query.jar"
$script:BandProbePackage = "com.rabiroute.bandprobe"
$script:HealthConnectLogTag = "RabiHealthBgRead"

$script:HeartRateProviderPaths = @(
    "heartrate/recent"
)

$script:HeartRateCandidatePaths = @(
    "heartrate",
    "heartrate/recent",
    "heartrate/day",
    "heartrate/days",
    "heartrate/history",
    "heartrate/record",
    "heartrate/records",
    "heartrate/report",
    "heartrate/daily",
    "heartrate/homepage",
    "heartrate/single",
    "heartrate/abnormal",
    "heart_rate",
    "heart_rate/recent",
    "hr",
    "hr/recent"
)

$script:SleepProviderPaths = @(
    "sleep/schedule",
    "sleep/homepage",
    "sleep/config",
    "sleep/record",
    "sleep/report"
)

$script:SleepCandidatePaths = @(
    "sleep",
    "sleep/schedule",
    "sleep/homepage",
    "sleep/config",
    "sleep/record",
    "sleep/report",
    "sleep/day",
    "sleep/days",
    "sleep/history",
    "sleep/records",
    "sleep/daily",
    "sleep/stage",
    "sleep/stages",
    "sleep/summary",
    "sleep/detail",
    "sleep/trace",
    "sleep/traces",
    "sleep/behavior",
    "sleep/quality",
    "sleep/stat",
    "sleep/stats"
)

$script:ProviderCallCandidateMethods = @(
    "get",
    "query",
    "read",
    "recent",
    "report",
    "record",
    "records",
    "history",
    "list",
    "daily",
    "day"
)

$script:ProviderCategoryCandidates = @(
    "heartrate",
    "sleep",
    "step",
    "steps",
    "spo2",
    "stress",
    "energy",
    "vitality",
    "pai",
    "stand",
    "calorie",
    "calories",
    "weight",
    "temperature",
    "temperaturetrend",
    "bloodpressure",
    "bloodsugar",
    "ecg",
    "sport",
    "trainingload",
    "vo2max",
    "runningindicator",
    "lactatethreshold",
    "hearing",
    "physicalstatus"
)

function Invoke-Adb {
    param(
        [string]$Serial = "",
        [Parameter(Mandatory)][string[]]$AdbArgs
    )

    $adbPrefix = @()
    if (-not [string]::IsNullOrWhiteSpace($Serial)) {
        $adbPrefix = @("-s", $Serial)
    }

    $output = & adb @adbPrefix @AdbArgs 2>&1
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "adb 执行失败 ($exitCode): adb $($adbPrefix -join ' ') $($AdbArgs -join ' ')`n$output"
    }
    return @($output)
}

function ConvertFrom-ContentRows {
    param([string[]]$Lines)

    $rows = @()
    foreach ($line in $Lines) {
        if ($line -notmatch '^Row:\s+\d+\s+') {
            continue
        }

        $row = [ordered]@{}
        $body = [regex]::Replace($line, '^Row:\s+\d+\s+', '')
        $keys = @([regex]::Matches($body, '(?:^|,\s+)([A-Za-z0-9_]+)='))
        for ($index = 0; $index -lt $keys.Count; $index++) {
            $keyMatch = $keys[$index]
            $key = $keyMatch.Groups[1].Value
            $valueStart = $keyMatch.Index + $keyMatch.Length
            $valueEnd = if ($index + 1 -lt $keys.Count) {
                $keys[$index + 1].Index
            } else {
                $body.Length
            }
            $value = $body.Substring($valueStart, $valueEnd - $valueStart)
            if ($value.EndsWith(", ")) {
                $value = $value.Substring(0, $value.Length - 2)
            }
            $row[$key] = $value.Trim()
        }
        $rows += [pscustomobject]$row
    }
    return $rows
}

function New-MiHealthResult {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Status,
        [object]$Data = $null,
        [string]$Reason = "",
        [string[]]$Raw = @()
    )

    [pscustomobject]@{
        source = $Source
        status = $Status
        data = $Data
        reason = $Reason
        raw = $Raw
    }
}

function Get-MiHealthProviderFailureReason {
    param([string[]]$Raw)

    $text = ($Raw -join "`n")
    if ($text -match "no provider deploy") {
        return "Provider 路由未注册。"
    }
    if ($text -match "SecurityException") {
        return "调用方没有小米健康 Provider 权限。"
    }
    if ($text -match "illegal call method") {
        return "Provider call 方法未注册或方法形状不符合小米健康分发规则。"
    }
    if ($text -match "Error while accessing provider") {
        return "Provider 返回错误。"
    }
    return ""
}

function Get-MiHealthProviderRowsStatus {
    param(
        [object[]]$Rows,
        [string[]]$Raw
    )

    $failureReason = Get-MiHealthProviderFailureReason -Raw $Raw
    if ($failureReason) {
        return [pscustomobject]@{
            status = "blocked"
            reason = $failureReason
        }
    }

    return [pscustomobject]@{
        status = if ($Rows.Count -gt 0) { "available" } else { "empty" }
        reason = ""
    }
}

function ConvertTo-MiHealthLocalTime {
    param([Int64]$TimestampMillis)

    return [DateTimeOffset]::FromUnixTimeMilliseconds($TimestampMillis).ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss zzz")
}

function ConvertFrom-HealthConnectLog {
    param([string[]]$Lines)

    $messages = @()
    foreach ($line in $Lines) {
        if ($line -match 'RabiHealthBgRead:\s*(.+)$') {
            $messages += $Matches[1].Trim()
        }
    }

    $data = [ordered]@{
        sdkStatus = $null
        grantedPermissions = @()
        heartRateRecordCount = $null
        heartRateSampleCount = $null
        sleepRecordCount = $null
        stepsRecordCount = $null
        stepsTotal = $null
        messages = $messages
    }

    foreach ($message in $messages) {
        if ($message -match 'Health Connect 状态：(\d+)') {
            $data.sdkStatus = [Int32]$Matches[1]
        } elseif ($message -match '已授权权限：(.+)$') {
            $data.grantedPermissions = @($Matches[1].Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        } elseif ($message -match '心率记录条数：(\d+)') {
            $data.heartRateRecordCount = [Int32]$Matches[1]
        } elseif ($message -match '心率样本数量：(\d+)') {
            $data.heartRateSampleCount = [Int32]$Matches[1]
        } elseif ($message -match '睡眠记录条数：(\d+)') {
            $data.sleepRecordCount = [Int32]$Matches[1]
        } elseif ($message -match '步数记录条数：(\d+)') {
            $data.stepsRecordCount = [Int32]$Matches[1]
        } elseif ($message -match '步数合计：(\d+)') {
            $data.stepsTotal = [Int64]$Matches[1]
        }
    }

    return [pscustomobject]$data
}

function Get-HealthConnectStatusFromData {
    param([object]$Data)

    if ($null -eq $Data.sdkStatus) {
        return "blocked"
    }

    if ($Data.sdkStatus -ne 3) {
        return "blocked"
    }

    $counts = @(
        $Data.heartRateSampleCount,
        $Data.sleepRecordCount,
        $Data.stepsRecordCount
    ) | Where-Object { $null -ne $_ }

    if ($counts.Count -gt 0 -and ($counts | Measure-Object -Sum).Sum -eq 0) {
        return "empty"
    }

    return "available"
}

function Get-MiHealthProviderPaths {
    param(
        [string]$Serial = "",
        [Parameter(Mandatory)][ValidateSet("heartrate", "sleep")][string]$Category
    )

    try {
        $raw = Invoke-MiHealthContentQuery -Serial $Serial -Path $Category
        $rows = ConvertFrom-ContentRows -Lines $raw
        $paths = @($rows | ForEach-Object { $_.path })
        return New-MiHealthResult -Source $Category -Status "available" -Data $paths -Raw $raw
    } catch {
        return New-MiHealthResult -Source $Category -Status "blocked" -Reason $_.Exception.Message
    }
}

function Test-MiHealthProviderCategories {
    param(
        [string]$Serial = "",
        [string[]]$Categories = $script:ProviderCategoryCandidates
    )

    $results = @()
    foreach ($category in $Categories) {
        try {
            $raw = Invoke-MiHealthContentQuery -Serial $Serial -Path $category
            $rows = ConvertFrom-ContentRows -Lines $raw
            $classified = Get-MiHealthProviderRowsStatus -Rows $rows -Raw $raw
            $results += New-MiHealthResult -Source $category -Status $classified.status -Data $rows -Reason $classified.reason -Raw $raw
        } catch {
            $reason = $_.Exception.Message
            $classifiedReason = Get-MiHealthProviderFailureReason -Raw @($reason)
            if ($classifiedReason) {
                $reason = $classifiedReason
            }
            $results += New-MiHealthResult -Source $category -Status "blocked" -Reason $reason -Raw @($_.Exception.Message)
        }
    }

    return [pscustomobject]@{
        source = "provider/categories"
        status = "composite"
        data = $results
    }
}

function Get-MiHealthProviderDiscovery {
    param(
        [string]$Serial = "",
        [switch]$IncludeProviderCall
    )

    $discovery = [ordered]@{
        source = "provider/discovery"
        status = "composite"
        categories = Test-MiHealthProviderCategories -Serial $Serial
        heartRatePaths = Test-MiHealthHeartRateProviderPaths -Serial $Serial
        sleepPaths = Test-MiHealthSleepProviderPaths -Serial $Serial
        providerCall = [pscustomobject]@{
            source = "provider-call-methods"
            status = "skipped"
            reason = "Provider call 探测较慢；需要时用 Get-MiHealthProviderDiscovery -IncludeProviderCall 或 Test-MiHealthProviderCallMethods 单独运行。"
        }
        healthProviderService = Get-MiHealthHealthProviderServiceCapabilities -Serial $Serial
    }

    if ($IncludeProviderCall) {
        $discovery.providerCall = Test-MiHealthProviderCallMethods -Serial $Serial
    }

    return [pscustomobject]$discovery
}

function Invoke-HealthConnectProbe {
    param(
        [string]$Serial = "",
        [int]$WaitSeconds = 4,
        [int]$HeartRateHours = 24,
        [int]$SleepHours = 48,
        [int]$StepsHours = 24
    )

    $source = "health-connect/background-read"
    try {
        Invoke-Adb -Serial $Serial -AdbArgs @("shell", "pm", "path", $script:BandProbePackage) | Out-Null
        Invoke-Adb -Serial $Serial -AdbArgs @("logcat", "-c") | Out-Null
        Invoke-Adb -Serial $Serial -AdbArgs @(
            "shell",
            "am",
            "broadcast",
            "-n",
            "$script:BandProbePackage/.HealthConnectReadReceiver",
            "--el",
            "heart_rate_hours",
            "$([Math]::Max(1, $HeartRateHours))",
            "--el",
            "sleep_hours",
            "$([Math]::Max(1, $SleepHours))",
            "--el",
            "steps_hours",
            "$([Math]::Max(1, $StepsHours))"
        ) | Out-Null
        Start-Sleep -Seconds $WaitSeconds
        $raw = Invoke-Adb -Serial $Serial -AdbArgs @("logcat", "-d", "-s", "$($script:HealthConnectLogTag):I")
        $data = ConvertFrom-HealthConnectLog -Lines $raw
        $status = Get-HealthConnectStatusFromData -Data $data
        $reason = if ($status -eq "empty") {
            "Health Connect 可读且权限存在，但当前没有小米健康写入的心率/睡眠样本。"
        } elseif ($status -eq "blocked") {
            "Health Connect 不可用、测试 APK 未安装、权限不足，或后台读取日志不完整。"
        } else {
            ""
        }
        return New-MiHealthResult -Source $source -Status $status -Data $data -Reason $reason -Raw $raw
    } catch {
        return New-MiHealthResult -Source $source -Status "blocked" -Reason $_.Exception.Message
    }
}

function Get-MiHealthHeartRateCapabilities {
    param([string]$Serial = "")

    $paths = Get-MiHealthProviderPaths -Serial $Serial -Category "heartrate"
    return [pscustomobject]@{
        source = "heartrate"
        status = $paths.status
        providerPaths = $paths
        available = @(
            [pscustomobject]@{
                name = "latestHeartRate"
                providerPath = "heartrate/recent"
                fields = @("hrm", "timestamp")
                api = "Get-MiHealthLatestHeartRate"
            }
        )
        blocked = @(
            [pscustomobject]@{
                name = "heartRate24Hours"
                expectedInternalModel = "DailyHrReport.hrRecords"
                api = "Get-MiHealthHeartRate24Hours"
                reason = "Provider only exposes heartrate/recent."
            },
            [pscustomobject]@{
                name = "singleMeasurements"
                expectedInternalModel = "DailyHrReport.singleHrRecords"
                api = "Get-MiHealthSingleHeartRateMeasurements"
                reason = "No confirmed Provider path."
            },
            [pscustomobject]@{
                name = "abnormalHeartRate"
                expectedInternalModel = "DailyHrReport.abnormalHrRecords / abnormalHrHighRecords / abnormalHrLowRecords / abnormalFibRecords"
                api = "Get-MiHealthAbnormalHeartRateEvents"
                reason = "No confirmed Provider path."
            }
        )
    }
}

function Test-MiHealthHeartRateProviderPaths {
    param([string]$Serial = "")

    $results = @()
    foreach ($path in $script:HeartRateCandidatePaths) {
        try {
            $projection = if ($path -eq "heartrate/recent") { @("hrm", "timestamp") } else { @() }
            $raw = Invoke-MiHealthContentQuery -Serial $Serial -Path $path -Projection $projection
            $rows = ConvertFrom-ContentRows -Lines $raw
            $classified = Get-MiHealthProviderRowsStatus -Rows $rows -Raw $raw
            $results += New-MiHealthResult -Source $path -Status $classified.status -Data $rows -Reason $classified.reason -Raw $raw
        } catch {
            $reason = $_.Exception.Message
            $classifiedReason = Get-MiHealthProviderFailureReason -Raw @($reason)
            if ($classifiedReason) {
                $reason = $classifiedReason
            }
            $results += New-MiHealthResult -Source $path -Status "blocked" -Reason $reason -Raw @($_.Exception.Message)
        }
    }

    return [pscustomobject]@{
        source = "heartrate/provider-candidates"
        status = "composite"
        data = $results
    }
}

function Invoke-MiHealthProviderCall {
    param(
        [string]$Serial = "",
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Method,
        [string]$Arg = "",
        [string[]]$Extras = @()
    )

    $Path = $Path.Replace("\", "/").TrimStart("/")
    $methodUri = "$script:ProviderRoot/$Path#$Method"
    $args = @(
        "shell",
        "content",
        "call",
        "--uri",
        $script:ProviderRoot,
        "--method",
        $methodUri
    )
    if ($Arg) {
        $args += @("--arg", $Arg)
    }
    foreach ($extra in $Extras) {
        $args += @("--extra", $extra)
    }
    return Invoke-Adb -Serial $Serial -AdbArgs $args
}

function Test-MiHealthProviderCallMethods {
    param(
        [string]$Serial = "",
        [string[]]$Paths = @("heartrate/recent", "heartrate", "sleep/report", "sleep/record"),
        [string[]]$Methods = $script:ProviderCallCandidateMethods
    )

    $results = @()
    foreach ($path in $Paths) {
        foreach ($method in $Methods) {
            try {
                $raw = Invoke-MiHealthProviderCall -Serial $Serial -Path $path -Method $method
                $failureReason = Get-MiHealthProviderFailureReason -Raw $raw
                $hasValue = ($raw -join "`n") -notmatch "Result:\s+null"
                $status = if ($failureReason) { "blocked" } elseif ($hasValue) { "available" } else { "empty" }
                $results += New-MiHealthResult -Source "$path#$method" -Status $status -Reason $failureReason -Raw $raw
            } catch {
                $reason = $_.Exception.Message
                $classifiedReason = Get-MiHealthProviderFailureReason -Raw @($reason)
                if ($classifiedReason) {
                    $reason = $classifiedReason
                }
                $results += New-MiHealthResult -Source "$path#$method" -Status "blocked" -Reason $reason -Raw @($_.Exception.Message)
            }
        }
    }

    return [pscustomobject]@{
        source = "provider-call-methods"
        status = "composite"
        data = $results
    }
}

function Get-MiHealthHealthProviderServiceCapabilities {
    param([string]$Serial = "")

    try {
        $raw = Invoke-Adb -Serial $Serial -AdbArgs @("shell", "dumpsys", "package", "com.mi.health")
        $text = $raw -join "`n"
        $hasService = $text -match "com\.mi\.health_provider\.HealthProviderService"
        $hasAction = $text -match "com\.mi\.health\.action\.HEALTH_PROVIDER"
        $permission = if ($text -match "com\.mi\.health\.permission\.health_provider: prot=([^\r\n]+)") {
            $Matches[1].Trim()
        } elseif ($text -match "Permission \[com\.mi\.health\.permission\.health_provider\][\s\S]*?prot=([^\r\n]+)") {
            $Matches[1].Trim()
        } else {
            ""
        }

        $status = if ($hasService -and $permission -match "signature|privileged|preinstalled") {
            "blocked"
        } elseif ($hasService) {
            "available"
        } else {
            "empty"
        }

        $reason = if ($status -eq "blocked") {
            "HealthProviderService 存在，但绑定权限是 $permission，普通 APK 不能作为稳定数据通道。"
        } elseif ($status -eq "empty") {
            "当前小米健康包没有发现 HealthProviderService。"
        } else {
            ""
        }

        return New-MiHealthResult -Source "health-provider-service" -Status $status -Data ([pscustomobject]@{
            service = "com.mi.health_provider.HealthProviderService"
            action = "com.mi.health.action.HEALTH_PROVIDER"
            permission = "com.mi.health.permission.health_provider"
            protectionLevel = $permission
            hasService = $hasService
            hasAction = $hasAction
        }) -Reason $reason -Raw @($raw | Where-Object { $_ -match "HealthProviderService|HEALTH_PROVIDER|health_provider" })
    } catch {
        return New-MiHealthResult -Source "health-provider-service" -Status "blocked" -Reason $_.Exception.Message
    }
}

function Get-MiHealthSleepCapabilities {
    param([string]$Serial = "")

    $paths = Get-MiHealthProviderPaths -Serial $Serial -Category "sleep"
    return [pscustomobject]@{
        source = "sleep"
        status = $paths.status
        providerPaths = $paths
        available = @(
            [pscustomobject]@{
                name = "sleepSchedule"
                providerPath = "sleep/schedule"
                fields = @("repeat", "sleep_hour", "sleep_min", "wake_hour", "wake_min")
                api = "Get-MiHealthSleepSchedule"
            },
            [pscustomobject]@{
                name = "sleepConfig"
                providerPath = "sleep/config"
                fields = @("trace_enable")
                api = "Get-MiHealthSleepConfig"
            },
            [pscustomobject]@{
                name = "sleepHomepageIntent"
                providerPath = "sleep/homepage"
                fields = @("intent")
                api = "Get-MiHealthSleepHomepage"
            }
        )
        conditional = @(
            [pscustomobject]@{
                name = "sleepReport"
                providerPath = "sleep/report"
                fields = @("sleep_time", "wake_time", "duration", "waking_times", "stage_list", "waking_duration", "evaluation")
                api = "Get-MiHealthSleepReport"
                note = "Requires date_time selection argument."
            },
            [pscustomobject]@{
                name = "sleepStages"
                providerPath = "sleep/record"
                fields = @("begin_time", "end_time", "stage")
                api = "Get-MiHealthSleepStages"
                note = "Requires date_time >= ? and date_time <= ?; between ? and ? is rejected by Xiaomi's parser."
            }
        )
    }
}

function Test-MiHealthSleepProviderPaths {
    param(
        [string]$Serial = "",
        [DateTimeOffset]$Date = [DateTimeOffset]::Now
    )

    $results = @()
    foreach ($path in $script:SleepCandidatePaths) {
        try {
            if ($path -eq "sleep/report") {
                $results += Get-MiHealthSleepReport -Serial $Serial -Date $Date
                continue
            }
            if ($path -eq "sleep/record") {
                $results += Get-MiHealthSleepStages -Serial $Serial -Date $Date
                continue
            }

            $raw = Invoke-MiHealthContentQuery -Serial $Serial -Path $path
            $rows = ConvertFrom-ContentRows -Lines $raw
            $classified = Get-MiHealthProviderRowsStatus -Rows $rows -Raw $raw
            $results += New-MiHealthResult -Source $path -Status $classified.status -Data $rows -Reason $classified.reason -Raw $raw
        } catch {
            $reason = $_.Exception.Message
            $classifiedReason = Get-MiHealthProviderFailureReason -Raw @($reason)
            if ($classifiedReason) {
                $reason = $classifiedReason
            }
            $results += New-MiHealthResult -Source $path -Status "blocked" -Reason $reason -Raw @($_.Exception.Message)
        }
    }

    return [pscustomobject]@{
        source = "sleep/provider-candidates"
        status = "composite"
        data = $results
    }
}

function Initialize-MiHealthProviderBridge {
    param([string]$Serial = "")

    $buildScript = Join-Path $PSScriptRoot "Build-MiHealthProviderQuery.ps1"
    $jarPath = (& $buildScript | Select-Object -Last 1).Trim()
    Invoke-Adb -Serial $Serial -AdbArgs @("push", $jarPath, $script:BridgeJarDevicePath) | Out-Null
    return $script:BridgeJarDevicePath
}

function Invoke-MiHealthProviderQuery {
    param(
        [string]$Serial = "",
        [Parameter(Mandatory)][string]$Path,
        [string[]]$Projection = @(),
        [string]$Selection = "-",
        [string[]]$SelectionArgs = @(),
        [string]$Sort = "-"
    )

    $Path = $Path.Replace("\", "/").TrimStart("/")
    $projectionArg = if ($Projection.Count -gt 0) { $Projection -join "," } else { "-" }
    $selectionArg = if ($Selection) { $Selection } else { "-" }
    $selectionArgsArg = if ($SelectionArgs.Count -gt 0) { $SelectionArgs -join "," } else { "-" }
    $uri = "$script:ProviderRoot/$Path"

    $command = "CLASSPATH=$script:BridgeJarDevicePath app_process /system/bin MiHealthProviderQuery '$uri' '$projectionArg' '$selectionArg' '$selectionArgsArg' '$Sort'"
    return Invoke-Adb -Serial $Serial -AdbArgs @("shell", $command)
}

function Invoke-MiHealthContentQuery {
    param(
        [string]$Serial = "",
        [Parameter(Mandatory)][string]$Path,
        [string[]]$Projection = @()
    )

    $Path = $Path.Replace("\", "/").TrimStart("/")
    $args = @("shell", "content", "query", "--uri", "$script:ProviderRoot/$Path")
    if ($Projection.Count -gt 0) {
        $args += @("--projection", ($Projection -join ":"))
    }
    return Invoke-Adb -Serial $Serial -AdbArgs $args
}

function Get-MiHealthLatestHeartRate {
    param([string]$Serial = "")

    $source = "heartrate/recent"
    try {
        $raw = Invoke-MiHealthContentQuery -Serial $Serial -Path $source -Projection @("hrm", "timestamp")
        $rows = ConvertFrom-ContentRows -Lines $raw
        if ($rows.Count -eq 0) {
            return New-MiHealthResult -Source $source -Status "empty" -Raw $raw
        }
        $row = $rows[0]
        $timestamp = [Int64]$row.timestamp
        $data = [pscustomobject]@{
            heartRateBpm = [Int32]$row.hrm
            timestampMillis = $timestamp
            localTime = ConvertTo-MiHealthLocalTime -TimestampMillis $timestamp
        }
        return New-MiHealthResult -Source $source -Status "available" -Data $data -Raw $raw
    } catch {
        return New-MiHealthResult -Source $source -Status "blocked" -Reason $_.Exception.Message
    }
}

function Get-MiHealthHeartRate24Hours {
    param([string]$Serial = "")

    $source = "heartrate/24h"
    $latest = Get-MiHealthLatestHeartRate -Serial $Serial
    return New-MiHealthResult `
        -Source $source `
        -Status "blocked" `
        -Data ([pscustomobject]@{
            latestHeartRate = $latest
            availableProviderPath = "heartrate/recent"
            internalDataHint = "com.xiaomi.fit.fitness.export.data.aggregation.DailyHrReport exposes HrRecords inside Xiaomi Health, but no public Provider path is confirmed yet."
        }) `
        -Reason "小米健康 Provider 当前只枚举出 heartrate/recent；最近 24 小时心率曲线在普通 APK 和当前 ADB Provider 路线下还没有可用入口。"
}

function Get-MiHealthSingleHeartRateMeasurements {
    param([string]$Serial = "")

    return New-MiHealthResult `
        -Source "heartrate/single" `
        -Status "blocked" `
        -Data ([pscustomobject]@{
            expectedInternalModel = "DailyHrReport.singleHrRecords"
            testedProviderPaths = @("heartrate/single", "heartrate/record", "heartrate/records")
        }) `
        -Reason "小米健康内部有单次心率模型线索，但当前 Provider 候选路径没有暴露可读取数据。"
}

function Get-MiHealthAbnormalHeartRateEvents {
    param([string]$Serial = "")

    return New-MiHealthResult `
        -Source "heartrate/abnormal" `
        -Status "blocked" `
        -Data ([pscustomobject]@{
            expectedInternalModels = @(
                "DailyHrReport.abnormalHrRecords",
                "DailyHrReport.abnormalHrHighRecords",
                "DailyHrReport.abnormalHrLowRecords",
                "DailyHrReport.abnormalFibRecords"
            )
            testedProviderPaths = @("heartrate/abnormal", "heartrate/report", "heartrate/history")
        }) `
        -Reason "小米健康内部有异常心率模型线索，但当前 Provider 候选路径没有暴露可读取数据。"
}

function Get-MiHealthHeartRateAll {
    param([string]$Serial = "")

    return [pscustomobject]@{
        source = "heartrate/all"
        status = "composite"
        capabilities = Get-MiHealthHeartRateCapabilities -Serial $Serial
        latest = Get-MiHealthLatestHeartRate -Serial $Serial
        last24Hours = Get-MiHealthHeartRate24Hours -Serial $Serial
        singleMeasurements = Get-MiHealthSingleHeartRateMeasurements -Serial $Serial
        abnormalEvents = Get-MiHealthAbnormalHeartRateEvents -Serial $Serial
    }
}

function Get-MiHealthSleepSchedule {
    param([string]$Serial = "")

    $source = "sleep/schedule"
    try {
        $raw = Invoke-MiHealthContentQuery -Serial $Serial -Path $source
        $rows = ConvertFrom-ContentRows -Lines $raw
        return New-MiHealthResult -Source $source -Status "available" -Data $rows -Raw $raw
    } catch {
        return New-MiHealthResult -Source $source -Status "blocked" -Reason $_.Exception.Message
    }
}

function Get-MiHealthSleepHomepage {
    param([string]$Serial = "")

    $source = "sleep/homepage"
    try {
        $raw = Invoke-MiHealthContentQuery -Serial $Serial -Path $source
        $rows = ConvertFrom-ContentRows -Lines $raw
        $status = if ($rows.Count -gt 0) { "available" } else { "empty" }
        return New-MiHealthResult -Source $source -Status $status -Data $rows -Raw $raw
    } catch {
        return New-MiHealthResult -Source $source -Status "blocked" -Reason $_.Exception.Message
    }
}

function Get-MiHealthSleepConfig {
    param([string]$Serial = "")

    $source = "sleep/config"
    try {
        $raw = Invoke-MiHealthContentQuery -Serial $Serial -Path $source
        $rows = ConvertFrom-ContentRows -Lines $raw
        return New-MiHealthResult -Source $source -Status "available" -Data $rows -Raw $raw
    } catch {
        return New-MiHealthResult -Source $source -Status "blocked" -Reason $_.Exception.Message
    }
}

function New-MiHealthDayRange {
    param([DateTimeOffset]$Date = [DateTimeOffset]::Now)

    $dayStart = [DateTimeOffset]::new($Date.Date, [TimeSpan]::FromHours(8))
    $dayEnd = [DateTimeOffset]::new($Date.Date.AddDays(1).AddMilliseconds(-1), [TimeSpan]::FromHours(8))
    return [pscustomobject]@{
        date = $Date.ToString("yyyy-MM-dd")
        startMillis = $dayStart.ToUnixTimeMilliseconds()
        endMillis = $dayEnd.ToUnixTimeMilliseconds()
        startLocalTime = $dayStart.ToString("yyyy-MM-dd HH:mm:ss zzz")
        endLocalTime = $dayEnd.ToString("yyyy-MM-dd HH:mm:ss zzz")
    }
}

function Get-MiHealthSleepReport {
    param(
        [string]$Serial = "",
        [DateTimeOffset]$Date = [DateTimeOffset]::Now
    )

    $source = "sleep/report"
    $startMillis = [DateTimeOffset]::new($Date.Date, [TimeSpan]::FromHours(8)).ToUnixTimeMilliseconds()
    try {
        $raw = Invoke-MiHealthProviderQuery -Serial $Serial -Path $source -Selection "date_time" -SelectionArgs @("$startMillis")
        $rows = ConvertFrom-ContentRows -Lines $raw
        $status = if ($rows.Count -gt 0) { "available" } else { "empty" }
        return New-MiHealthResult -Source $source -Status $status -Data $rows -Raw $raw
    } catch {
        return New-MiHealthResult -Source $source -Status "blocked" -Reason $_.Exception.Message
    }
}

function Get-MiHealthSleepStages {
    param(
        [string]$Serial = "",
        [DateTimeOffset]$Date = [DateTimeOffset]::Now
    )

    $source = "sleep/record"
    $dayStart = [DateTimeOffset]::new($Date.Date, [TimeSpan]::FromHours(8))
    $dayEnd = [DateTimeOffset]::new($Date.Date.AddDays(1).AddMilliseconds(-1), [TimeSpan]::FromHours(8))
    try {
        $raw = Invoke-MiHealthProviderQuery `
            -Serial $Serial `
            -Path $source `
            -Projection @("begin_time", "end_time", "stage") `
            -Selection "date_time >= ? and date_time <= ?" `
            -SelectionArgs @("$($dayStart.ToUnixTimeMilliseconds())", "$($dayEnd.ToUnixTimeMilliseconds())")
        $rows = ConvertFrom-ContentRows -Lines $raw
        $status = if ($rows.Count -gt 0) { "available" } else { "empty" }
        return New-MiHealthResult -Source $source -Status $status -Data $rows -Raw $raw
    } catch {
        return New-MiHealthResult -Source $source -Status "blocked" -Reason $_.Exception.Message
    }
}

function Get-MiHealthSleepDay {
    param(
        [string]$Serial = "",
        [DateTimeOffset]$Date = [DateTimeOffset]::Now
    )

    $range = New-MiHealthDayRange -Date $Date
    return [pscustomObject]@{
        source = "sleep/day"
        status = "composite"
        range = $range
        schedule = Get-MiHealthSleepSchedule -Serial $Serial
        config = Get-MiHealthSleepConfig -Serial $Serial
        homepage = Get-MiHealthSleepHomepage -Serial $Serial
        report = Get-MiHealthSleepReport -Serial $Serial -Date $Date
        stages = Get-MiHealthSleepStages -Serial $Serial -Date $Date
    }
}

function Get-MiHealthSleepRecentDays {
    param(
        [string]$Serial = "",
        [int]$Days = 3
    )

    $daysToRead = [Math]::Max(1, $Days)
    $items = @()
    for ($offset = 0; $offset -lt $daysToRead; $offset++) {
        $items += Get-MiHealthSleepDay -Serial $Serial -Date ([DateTimeOffset]::Now.AddDays(-$offset))
    }
    return [pscustomobject]@{
        source = "sleep/recent-days"
        status = "composite"
        days = $items
    }
}

function Search-MiHealthSleepData {
    param(
        [string]$Serial = "",
        [int]$DaysBack = 30,
        [switch]$IncludeEmptyDays
    )

    $daysToRead = [Math]::Max(1, $DaysBack)
    $days = @()
    $availableDays = @()
    for ($offset = 0; $offset -lt $daysToRead; $offset++) {
        $day = Get-MiHealthSleepDay -Serial $Serial -Date ([DateTimeOffset]::Now.AddDays(-$offset))
        $hasReport = $day.report.status -eq "available"
        $hasStages = $day.stages.status -eq "available"
        if ($IncludeEmptyDays -or $hasReport -or $hasStages) {
            $days += $day
        }
        if ($hasReport -or $hasStages) {
            $availableDays += [pscustomobject]@{
                date = $day.range.date
                reportStatus = $day.report.status
                stagesStatus = $day.stages.status
            }
        }
    }

    return [pscustomobject]@{
        source = "sleep/search"
        status = if ($availableDays.Count -gt 0) { "available" } else { "empty" }
        searchedDaysBack = $daysToRead
        availableDays = $availableDays
        days = $days
        reason = if ($availableDays.Count -eq 0) { "扫描窗口内 sleep/report 和 sleep/record 都没有返回睡眠日报或阶段数据。" } else { "" }
    }
}

function Get-MiHealthSleepAll {
    param(
        [string]$Serial = "",
        [int]$Days = 3
    )

    return [pscustomobject]@{
        source = "sleep/all"
        status = "composite"
        capabilities = Get-MiHealthSleepCapabilities -Serial $Serial
        providerCandidates = Test-MiHealthSleepProviderPaths -Serial $Serial
        schedule = Get-MiHealthSleepSchedule -Serial $Serial
        config = Get-MiHealthSleepConfig -Serial $Serial
        homepage = Get-MiHealthSleepHomepage -Serial $Serial
        recentDays = Get-MiHealthSleepRecentDays -Serial $Serial -Days $Days
    }
}

function Get-MiHealthDataCoverage {
    param([string]$Serial = "")

    [pscustomobject]@{
        heartRate = Get-MiHealthHeartRateCapabilities -Serial $Serial
        sleep = Get-MiHealthSleepCapabilities -Serial $Serial
        healthConnect = [pscustomobject]@{
            source = "health-connect"
            status = "probe-required"
            availableApis = @(
                "HeartRateRecord",
                "SleepSessionRecord",
                "StepsRecord"
            )
            api = "Invoke-HealthConnectProbe"
            note = "Needs the Android probe APK installed and Health Connect permissions granted. Current device can run it in the background."
        }
        providerCall = [pscustomobject]@{
            source = "provider-call"
            status = "probe-required"
            api = "Test-MiHealthProviderCallMethods"
            note = "小米健康 call() 要求 method 形如 content://com.mi.health.provider.main/path#method；当前心率/睡眠候选方法实测均返回 Result: null。"
        }
        providerCategories = [pscustomobject]@{
            source = "provider/categories"
            status = "probe-required"
            api = "Test-MiHealthProviderCategories"
            note = "当前实测 heartrate、sleep、hearing 有枚举路径；其他常见健康分类多为 Provider 路由未注册。"
        }
        healthProviderService = Get-MiHealthHealthProviderServiceCapabilities -Serial $Serial
        notes = @(
            "available means the current ADB Provider route can read it.",
            "conditional means the Provider path exists but query arguments or data presence still need per-device verification.",
            "blocked means Xiaomi Health has no confirmed public Provider path or rejects the current caller."
        )
    }
}

function Get-MiHealthSnapshot {
    param([string]$Serial = "")

    [pscustomobject]@{
        coverage = Get-MiHealthDataCoverage -Serial $Serial
        healthConnect = Invoke-HealthConnectProbe -Serial $Serial
        heartRate = Get-MiHealthHeartRateAll -Serial $Serial
        sleep = Get-MiHealthSleepAll -Serial $Serial -Days 1
    }
}

function Get-MiHealthSummary {
    param(
        [string]$Serial = "",
        [int]$SleepSearchDays = 3,
        [switch]$SkipHealthConnect,
        [switch]$IncludeSleepHistorySearch,
        [switch]$IncludeProviderCategoryScan
    )

    $latestHeartRate = Get-MiHealthLatestHeartRate -Serial $Serial
    $heartRateCapabilities = Get-MiHealthHeartRateCapabilities -Serial $Serial
    $sleepCapabilities = Get-MiHealthSleepCapabilities -Serial $Serial
    $sleepSchedule = Get-MiHealthSleepSchedule -Serial $Serial
    $sleepConfig = Get-MiHealthSleepConfig -Serial $Serial
    $sleepSearch = if ($IncludeSleepHistorySearch) {
        Search-MiHealthSleepData -Serial $Serial -DaysBack $SleepSearchDays
    } else {
        [pscustomobject]@{
            source = "sleep/search"
            status = "skipped"
            searchedDaysBack = 0
            availableDays = @()
            reason = "默认摘要跳过睡眠历史扫描；需要时加 -IncludeSleepHistorySearch。"
        }
    }
    $providerCategories = if ($IncludeProviderCategoryScan) {
        Test-MiHealthProviderCategories -Serial $Serial
    } else {
        [pscustomobject]@{
            source = "provider/categories"
            status = "skipped"
            data = @()
            reason = "默认摘要跳过 Provider 分类扫描；需要时加 -IncludeProviderCategoryScan。"
        }
    }
    $healthProviderService = Get-MiHealthHealthProviderServiceCapabilities -Serial $Serial
    $healthConnect = if ($SkipHealthConnect) {
        New-MiHealthResult -Source "health-connect/background-read" -Status "skipped" -Reason "调用方要求跳过 Health Connect 后台读取。"
    } else {
        Invoke-HealthConnectProbe -Serial $Serial
    }

    $availableCategories = [System.Collections.Generic.List[object]]::new()
    $blockedCategories = [System.Collections.Generic.List[object]]::new()
    if ($providerCategories.status -ne "skipped") {
        @($providerCategories.data | Where-Object { $_.status -eq "available" } | ForEach-Object { $_.source }) |
            ForEach-Object { $availableCategories.Add($_) }
        @($providerCategories.data | Where-Object { $_.status -eq "blocked" } | ForEach-Object { $_.source }) |
            ForEach-Object { $blockedCategories.Add($_) }
    }

    return [pscustomobject]@{
        source = "mi-health/summary"
        status = "composite"
        heartRate = [pscustomobject]@{
            latest = [pscustomobject]@{
                status = $latestHeartRate.status
                bpm = if ($latestHeartRate.data) { $latestHeartRate.data.heartRateBpm } else { $null }
                localTime = if ($latestHeartRate.data) { $latestHeartRate.data.localTime } else { $null }
            }
            availableApis = @($heartRateCapabilities.available | ForEach-Object { $_.api })
            blockedApis = @($heartRateCapabilities.blocked | ForEach-Object { $_.api })
            reason = "当前 Provider 只确认 heartrate/recent；24 小时曲线、单次心率、异常心率没有外部可读路径。"
        }
        sleep = [pscustomobject]@{
            providerPaths = $sleepCapabilities.providerPaths.data
            scheduleStatus = $sleepSchedule.status
            schedule = $sleepSchedule.data
            configStatus = $sleepConfig.status
            config = $sleepConfig.data
            reportSearchStatus = $sleepSearch.status
            searchedDaysBack = $sleepSearch.searchedDaysBack
            availableDays = $sleepSearch.availableDays
            reason = if ($sleepSearch.status -eq "empty") {
                "扫描窗口内 sleep/report 和 sleep/record 没有日报或阶段数据。"
            } elseif ($sleepSearch.status -eq "skipped") {
                $sleepSearch.reason
            } else {
                ""
            }
        }
        healthConnect = [pscustomobject]@{
            status = $healthConnect.status
            heartRateSampleCount = if ($healthConnect.data) { $healthConnect.data.heartRateSampleCount } else { $null }
            sleepRecordCount = if ($healthConnect.data) { $healthConnect.data.sleepRecordCount } else { $null }
            stepsRecordCount = if ($healthConnect.data) { $healthConnect.data.stepsRecordCount } else { $null }
            reason = $healthConnect.reason
        }
        provider = [pscustomobject]@{
            categoryScanStatus = $providerCategories.status
            categoryScanReason = $providerCategories.reason
            availableCategories = $availableCategories
            blockedCategories = $blockedCategories
            healthProviderServiceStatus = $healthProviderService.status
            healthProviderServiceReason = $healthProviderService.reason
        }
    }
}

Export-ModuleMember -Function `
    Initialize-MiHealthProviderBridge, `
    Invoke-MiHealthProviderQuery, `
    Invoke-MiHealthProviderCall, `
    Get-MiHealthProviderPaths, `
    Test-MiHealthProviderCategories, `
    Get-MiHealthProviderDiscovery, `
    Invoke-HealthConnectProbe, `
    Get-MiHealthHeartRateCapabilities, `
    Test-MiHealthHeartRateProviderPaths, `
    Test-MiHealthProviderCallMethods, `
    Get-MiHealthHealthProviderServiceCapabilities, `
    Get-MiHealthSleepCapabilities, `
    Test-MiHealthSleepProviderPaths, `
    Get-MiHealthLatestHeartRate, `
    Get-MiHealthHeartRate24Hours, `
    Get-MiHealthSingleHeartRateMeasurements, `
    Get-MiHealthAbnormalHeartRateEvents, `
    Get-MiHealthHeartRateAll, `
    Get-MiHealthSleepSchedule, `
    Get-MiHealthSleepHomepage, `
    Get-MiHealthSleepConfig, `
    Get-MiHealthSleepReport, `
    Get-MiHealthSleepStages, `
    Get-MiHealthSleepDay, `
    Get-MiHealthSleepRecentDays, `
    Search-MiHealthSleepData, `
    Get-MiHealthSleepAll, `
    Get-MiHealthDataCoverage, `
    Get-MiHealthSnapshot, `
    Get-MiHealthSummary
