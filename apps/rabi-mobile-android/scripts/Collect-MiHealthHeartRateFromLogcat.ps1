param(
    [string]$Serial = "",
    [string]$AdbPath = "",
    [string]$OutputDir = "",
    [string]$InputLog = "",
    [int]$WaitSeconds = 8,
    [switch]$SkipLaunch
)

$ErrorActionPreference = "Stop"

function Resolve-AdbPath {
    param([string]$ExplicitPath)
    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
        if (-not (Test-Path -LiteralPath $ExplicitPath)) {
            throw "指定的 adb 不存在：$ExplicitPath"
        }
        return (Resolve-Path -LiteralPath $ExplicitPath).Path
    }

    $adbCommand = Get-Command adb -ErrorAction SilentlyContinue
    if ($adbCommand) {
        return $adbCommand.Source
    }

    $pythonAdb = Join-Path $env:LOCALAPPDATA "Programs\Python\Python310\Lib\site-packages\adbutils\binaries\adb.exe"
    if (Test-Path -LiteralPath $pythonAdb) {
        return $pythonAdb
    }

    throw "没有找到 adb。请传入 -AdbPath。"
}

function Invoke-Adb {
    param(
        [string]$Adb,
        [string]$Serial,
        [string[]]$Args
    )
    if ([string]::IsNullOrWhiteSpace($Serial)) {
        & $Adb @Args
    } else {
        & $Adb -s $Serial @Args
    }
}

function Format-LocalTime {
    param([long]$UnixSeconds)
    return [DateTimeOffset]::FromUnixTimeSeconds($UnixSeconds).ToOffset([TimeSpan]::FromHours(8)).ToString("yyyy-MM-dd HH:mm:ss zzz")
}

function ConvertTo-CsvField {
    param($Value)
    if ($null -eq $Value) {
        return ""
    }
    $text = [string]$Value
    if ($text -match '[,"\r\n]') {
        return '"' + $text.Replace('"', '""') + '"'
    }
    return $text
}

function Write-CsvRows {
    param(
        [string]$Path,
        [object[]]$Rows
    )
    $lines = foreach ($row in $Rows) {
        (($row | ForEach-Object { ConvertTo-CsvField $_ }) -join ",")
    }
    Set-Content -LiteralPath $Path -Value $lines -Encoding UTF8
}

function Parse-HeartRateLog {
    param(
        [string]$LogPath,
        [string]$OutputDir,
        [string]$Stamp
    )

    $lines = @(Get-Content -LiteralPath $LogPath -Encoding UTF8 |
        Where-Object { $_ -like "*refreshViewIfNeed:DailyHrReport*" })
    if (-not $lines -or $lines.Count -eq 0) {
        throw "日志里没有找到 refreshViewIfNeed:DailyHrReport：$LogPath"
    }

    $selectedLine = [string]$lines[-1]
    $reportText = $selectedLine.Substring($selectedLine.IndexOf("refreshViewIfNeed:") + "refreshViewIfNeed:".Length)

    $topPattern = "DailyHrReport\(time=(\d+), time = ([^,]+), tag='([^']*)', restHr=(-?\d+), avgHr=(-?\d+), maxHr=(-?\d+), minHr=(-?\d+), latestHrRecord=(null|HrItem\([^)]*\)), hrDistribute=(null|DailyHrDistribute\([^)]*\)), hrRecords=\["
    $top = [regex]::Match($reportText, $topPattern)
    if (-not $top.Success) {
        throw "无法解析 DailyHrReport 顶层字段。"
    }

    $latest = $null
    if ($top.Groups[8].Value -ne "null") {
        $latestMatch = [regex]::Match($top.Groups[8].Value, "HrItem\(sid=([^,]+), time=(\d+), hr=(-?\d+)\)")
        if ($latestMatch.Success) {
            $latest = [ordered]@{
                sid = $latestMatch.Groups[1].Value
                timeUnix = [long]$latestMatch.Groups[2].Value
                timeLocal = Format-LocalTime ([long]$latestMatch.Groups[2].Value)
                hr = [int]$latestMatch.Groups[3].Value
            }
        }
    }

    $distribute = $null
    if ($top.Groups[9].Value -ne "null") {
        $distMatch = [regex]::Match($top.Groups[9].Value, "DailyHrDistribute\(smooth=(-?\d+), warmUp=(-?\d+), fatBurn=(-?\d+), aerobic=(-?\d+), anaerobic=(-?\d+), extreme=(-?\d+)\)")
        if ($distMatch.Success) {
            $distribute = [ordered]@{
                smooth = [int]$distMatch.Groups[1].Value
                warmUp = [int]$distMatch.Groups[2].Value
                fatBurn = [int]$distMatch.Groups[3].Value
                aerobic = [int]$distMatch.Groups[4].Value
                anaerobic = [int]$distMatch.Groups[5].Value
                extreme = [int]$distMatch.Groups[6].Value
            }
        }
    }

    $records = @()
    $recordMatches = [regex]::Matches(
        $reportText,
        "TimesDataRecordInt\(time=(\d+), avgValue=(-?\d+), maxValue=(-?\d+), minValue=(-?\d+), valueArray=\[([^\]]*)\]\)"
    )
    foreach ($match in $recordMatches) {
        $values = @()
        $valueText = $match.Groups[5].Value.Trim()
        if (-not [string]::IsNullOrWhiteSpace($valueText)) {
            $values = $valueText.Split(",") | ForEach-Object { [int]$_.Trim() }
        }
        $sum = 0
        foreach ($value in $values) {
            $sum += $value
        }
        $computedAvg = $null
        $computedMin = $null
        $computedMax = $null
        if ($values.Count -gt 0) {
            $computedAvg = [Math]::Round($sum / $values.Count, 2)
            $computedMin = ($values | Measure-Object -Minimum).Minimum
            $computedMax = ($values | Measure-Object -Maximum).Maximum
        }
        $bucketStart = [long]$match.Groups[1].Value
        $records += [pscustomobject]@{
            bucketStartUnix = $bucketStart
            bucketStartLocal = Format-LocalTime $bucketStart
            loggedAvgValue = [int]$match.Groups[2].Value
            loggedMaxValue = [int]$match.Groups[3].Value
            loggedMinValue = [int]$match.Groups[4].Value
            values = @($values)
            count = $values.Count
            computedMin = $computedMin
            computedMax = $computedMax
            computedAvg = $computedAvg
        }
    }
    $records = @($records | Sort-Object bucketStartUnix)
    $sampleCount = ($records | Measure-Object -Property count -Sum).Sum
    if ($null -eq $sampleCount) {
        $sampleCount = 0
    }

    New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
    $jsonPath = Join-Path $OutputDir "mihealth-heart-records-$Stamp.json"
    $bucketCsvPath = Join-Path $OutputDir "mihealth-heart-records-$Stamp.csv"
    $expandedCsvPath = Join-Path $OutputDir "mihealth-heart-records-expanded-$Stamp.csv"

    $result = [ordered]@{
        status = "ok"
        source = [ordered]@{
            file = (Resolve-Path -LiteralPath $LogPath).Path
            method = "Xiaomi Health heart-rate page logcat DailyHrReport refreshViewIfNeed"
            capturedAtLocal = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss zzz")
        }
        limitations = @(
            "hrRecords 是小米健康当天图表聚合数据，不是直接数据库行。",
            "每条记录是桶起始时间 + valueArray；该日志没有桶内每个值的精确秒级时间。",
            "latestHrRecord 包含小米健康显示的最新样本精确时间。"
        )
        report = [ordered]@{
            reportStartUnix = [long]$top.Groups[1].Value
            reportStartLocal = Format-LocalTime ([long]$top.Groups[1].Value)
            reportLabelFromLog = $top.Groups[2].Value
            tag = $top.Groups[3].Value
            restHr = [int]$top.Groups[4].Value
            avgHr = [int]$top.Groups[5].Value
            maxHr = [int]$top.Groups[6].Value
            minHr = [int]$top.Groups[7].Value
            latestHrRecord = $latest
            hrDistribute = $distribute
            bucketCount = $records.Count
            sampleCount = [int]$sampleCount
            buckets = @($records)
        }
    }
    $result | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $jsonPath -Encoding UTF8

    $bucketRows = @(
        @("bucket_start_unix", "bucket_start_local", "values", "count", "computed_min", "computed_max", "computed_avg", "logged_avg_value", "logged_min_value", "logged_max_value")
    )
    foreach ($record in $records) {
        $bucketRows += ,@(
            $record.bucketStartUnix,
            $record.bucketStartLocal,
            (($record.values | ForEach-Object { [string]$_ }) -join " "),
            $record.count,
            $record.computedMin,
            $record.computedMax,
            $record.computedAvg,
            $record.loggedAvgValue,
            $record.loggedMinValue,
            $record.loggedMaxValue
        )
    }
    Write-CsvRows -Path $bucketCsvPath -Rows $bucketRows

    $expandedRows = @(
        @("bucket_start_unix", "bucket_start_local", "value_index_in_bucket", "hr")
    )
    foreach ($record in $records) {
        for ($i = 0; $i -lt $record.values.Count; $i++) {
            $expandedRows += ,@($record.bucketStartUnix, $record.bucketStartLocal, $i, $record.values[$i])
        }
    }
    Write-CsvRows -Path $expandedCsvPath -Rows $expandedRows

    return [pscustomobject]@{
        Json = (Resolve-Path -LiteralPath $jsonPath).Path
        Csv = (Resolve-Path -LiteralPath $bucketCsvPath).Path
        ExpandedCsv = (Resolve-Path -LiteralPath $expandedCsvPath).Path
        BucketCount = $records.Count
        SampleCount = [int]$sampleCount
    }
}

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $projectRoot "out\mi-health-logcat"
}
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"

if ([string]::IsNullOrWhiteSpace($InputLog)) {
    $adb = Resolve-AdbPath $AdbPath
    if (-not $SkipLaunch) {
        Invoke-Adb -Adb $adb -Serial $Serial -Args @("shell", "logcat", "-c") | Out-Null
        Invoke-Adb -Adb $adb -Serial $Serial -Args @("shell", "am", "start", "-a", "com.mi.health.action.ROUTER", "--es", "action", "heart_rate_home") | Out-Null
        Start-Sleep -Seconds $WaitSeconds
    }
    New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
    $InputLog = Join-Path $OutputDir "mihealth-logcat-heart-$stamp.txt"
    $logcat = Invoke-Adb -Adb $adb -Serial $Serial -Args @("shell", "logcat", "-d", "-v", "time")
    $filtered = $logcat | Where-Object {
        $_ -like "*MiHealth:hrm*" -or
        $_ -like "*DailyHrReport*" -or
        $_ -like "*TimesDataRecordInt*"
    }
    Set-Content -LiteralPath $InputLog -Value $filtered -Encoding UTF8
} else {
    $InputLog = (Resolve-Path -LiteralPath $InputLog).Path
    if ([string]::IsNullOrWhiteSpace($stamp)) {
        $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    }
}

Parse-HeartRateLog -LogPath $InputLog -OutputDir $OutputDir -Stamp $stamp
