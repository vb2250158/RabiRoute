param(
    [string]$Serial = "",
    [string]$AdbPath = "",
    [string]$OutputDir = "",
    [int]$DaysBack = 1,
    [int]$WaitSeconds = 4,
    [int]$SwipeStartX = 260,
    [int]$SwipeEndX = 1180,
    [int]$SwipeY = 1150,
    [int]$SwipeDurationMs = 500
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

function Format-LocalTime {
    param([long]$UnixSeconds)
    return [DateTimeOffset]::FromUnixTimeSeconds($UnixSeconds).ToOffset([TimeSpan]::FromHours(8)).ToString("yyyy-MM-dd HH:mm:ss zzz")
}

function Convert-DailyReportText {
    param(
        [string]$ReportText,
        [string]$RawLog
    )

    $topPattern = "DailyHrReport\(time=(\d+), time = ([^,]+), tag='([^']*)', restHr=(-?\d+), avgHr=(-?\d+), maxHr=(-?\d+), minHr=(-?\d+), latestHrRecord=(null|HrItem\([^)]*\)), hrDistribute=(null|DailyHrDistribute\([^)]*\)), hrRecords=\["
    $top = [regex]::Match($ReportText, $topPattern)
    if (-not $top.Success) {
        return $null
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
        $ReportText,
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
    $reportStart = [long]$top.Groups[1].Value
    return [pscustomobject]@{
        sourceRawLog = $RawLog
        reportStartUnix = $reportStart
        reportStartLocal = Format-LocalTime $reportStart
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

function Get-HeartRateLogcatLines {
    param(
        [string]$Adb,
        [string]$Serial
    )
    $logcat = Invoke-Adb -Adb $Adb -Serial $Serial -Args @("shell", "logcat", "-d", "-v", "time")
    return @($logcat | Where-Object {
        $_ -like "*MiHealth:hrm*" -or
        $_ -like "*DailyHrReport*" -or
        $_ -like "*TimesDataRecordInt*"
    })
}

if ($DaysBack -lt 0) {
    throw "-DaysBack 不能小于 0。"
}

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $projectRoot "out\mi-health-logcat"
}
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$adb = Resolve-AdbPath $AdbPath
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$rawLogs = @()
$allReportsByStart = @{}
$captureResults = @()

Invoke-Adb -Adb $adb -Serial $Serial -Args @("shell", "logcat", "-c") | Out-Null
Invoke-Adb -Adb $adb -Serial $Serial -Args @(
    "shell", "am", "start", "-a", "com.mi.health.action.ROUTER", "--es", "action", "heart_rate_home"
) | Out-Null
Start-Sleep -Seconds $WaitSeconds

for ($dayOffset = 0; $dayOffset -le $DaysBack; $dayOffset++) {
    if ($dayOffset -gt 0) {
        Invoke-Adb -Adb $adb -Serial $Serial -Args @("shell", "logcat", "-c") | Out-Null
        Invoke-Adb -Adb $adb -Serial $Serial -Args @(
            "shell", "input", "swipe",
            [string]$SwipeStartX,
            [string]$SwipeY,
            [string]$SwipeEndX,
            [string]$SwipeY,
            [string]$SwipeDurationMs
        ) | Out-Null
        Start-Sleep -Seconds $WaitSeconds
    }

    $rawLogPath = Join-Path $OutputDir "mihealth-logcat-heart-swipe-$stamp-dayOffset$dayOffset.txt"
    $filtered = Get-HeartRateLogcatLines -Adb $adb -Serial $Serial
    Set-Content -LiteralPath $rawLogPath -Value $filtered -Encoding UTF8
    $rawLogs += (Resolve-Path -LiteralPath $rawLogPath).Path

    $parsedInCapture = 0
    foreach ($line in $filtered) {
        $marker = "refreshViewIfNeed:"
        $markerIndex = ([string]$line).IndexOf($marker)
        if ($markerIndex -lt 0) {
            continue
        }
        $reportText = ([string]$line).Substring($markerIndex + $marker.Length)
        $report = Convert-DailyReportText -ReportText $reportText -RawLog (Resolve-Path -LiteralPath $rawLogPath).Path
        if ($null -ne $report) {
            $parsedInCapture++
            $allReportsByStart[[string]$report.reportStartUnix] = $report
        }
    }
    $captureResults += [pscustomobject]@{
        DayOffset = $dayOffset
        RawLog = (Resolve-Path -LiteralPath $rawLogPath).Path
        FilteredLineCount = $filtered.Count
        ParsedReportsInCapture = $parsedInCapture
    }
}

$reports = @($allReportsByStart.Values | Sort-Object reportStartUnix -Descending)
$combinedRows = @(
    @("report_start_local", "tag", "bucket_start_unix", "bucket_start_local", "values", "count", "computed_min", "computed_max", "computed_avg")
)
$expandedRows = @(
    @("report_start_local", "tag", "bucket_start_unix", "bucket_start_local", "value_index_in_bucket", "hr")
)

foreach ($report in $reports) {
    foreach ($bucket in $report.buckets) {
        $values = @($bucket.values)
        $combinedRows += ,@(
            $report.reportStartLocal,
            $report.tag,
            $bucket.bucketStartUnix,
            $bucket.bucketStartLocal,
            (($values | ForEach-Object { [string]$_ }) -join " "),
            $bucket.count,
            $bucket.computedMin,
            $bucket.computedMax,
            $bucket.computedAvg
        )
        for ($i = 0; $i -lt $values.Count; $i++) {
            $expandedRows += ,@(
                $report.reportStartLocal,
                $report.tag,
                $bucket.bucketStartUnix,
                $bucket.bucketStartLocal,
                $i,
                $values[$i]
            )
        }
    }
}

$combinedJsonPath = Join-Path $OutputDir "mihealth-heart-daily-reports-$stamp.json"
$combinedCsvPath = Join-Path $OutputDir "mihealth-heart-daily-reports-$stamp.csv"
$combinedExpandedCsvPath = Join-Path $OutputDir "mihealth-heart-daily-reports-expanded-$stamp.csv"

$summary = [ordered]@{
    status = "ok"
    channel = "foreground-logcat-diagnostic"
    isBackendApi = $false
    method = "Open Xiaomi Health heart-rate page, swipe day chart backward, parse DailyHrReport from logcat"
    limitations = @(
        "This is a foreground Xiaomi Health page/logcat diagnostic route, not a background Provider, Service, Health Connect, or cloud API.",
        "The phone must stay on the Xiaomi Health heart-rate page while the script launches and swipes.",
        "DailyHrReport.hrRecords is chart aggregation data; bucket values do not include exact per-sample seconds."
    )
    daysRequested = $DaysBack + 1
    reportsParsed = $reports.Count
    bucketCount = (($reports | ForEach-Object { $_.bucketCount }) | Measure-Object -Sum).Sum
    sampleCount = (($reports | ForEach-Object { $_.sampleCount }) | Measure-Object -Sum).Sum
    rawLogs = $rawLogs
    captureResults = @($captureResults)
    reports = @($reports)
}
$summary | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $combinedJsonPath -Encoding UTF8
Write-CsvRows -Path $combinedCsvPath -Rows $combinedRows
Write-CsvRows -Path $combinedExpandedCsvPath -Rows $expandedRows

[pscustomobject]@{
    Json = (Resolve-Path -LiteralPath $combinedJsonPath).Path
    Csv = (Resolve-Path -LiteralPath $combinedCsvPath).Path
    ExpandedCsv = (Resolve-Path -LiteralPath $combinedExpandedCsvPath).Path
    ReportsParsed = $reports.Count
    BucketCount = $summary.bucketCount
    SampleCount = $summary.sampleCount
}
