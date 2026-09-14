param(
    [string]$Serial = "",
    [string]$OutputJson
)

$ErrorActionPreference = "Stop"

function Invoke-Adb {
    param([string[]]$AdbArgs)

    $output = & adb @AdbArgs 2>&1
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "adb 执行失败 ($exitCode): adb $($AdbArgs -join ' ')`n$output"
    }
    return $output
}

function Parse-ContentRow {
    param([string]$Line)

    $result = [ordered]@{}
    $matches = [regex]::Matches($Line, '([A-Za-z0-9_]+)=([^,\r\n]+)')
    foreach ($match in $matches) {
        $result[$match.Groups[1].Value] = $match.Groups[2].Value.Trim()
    }
    return $result
}

function Convert-MillisToLocalIso {
    param([Int64]$Millis)

    return [DateTimeOffset]::FromUnixTimeMilliseconds($Millis).ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss zzz")
}

$uri = "content://com.mi.health.provider.main/heartrate/recent"
$projection = "hrm:timestamp"

$adbSerialArgs = @()
if (-not [string]::IsNullOrWhiteSpace($Serial)) {
    $adbSerialArgs = @("-s", $Serial)
}

$raw = Invoke-Adb -AdbArgs ($adbSerialArgs + @(
    "shell", "content", "query",
    "--uri", $uri,
    "--projection", $projection
))

$rowLine = ($raw | Where-Object { $_ -match '^Row:' } | Select-Object -First 1)
if (-not $rowLine) {
    throw "没有从小米健康 Provider 读到心率数据。原始输出:`n$raw"
}

$row = Parse-ContentRow -Line $rowLine
if (-not $row.Contains("hrm") -or -not $row.Contains("timestamp")) {
    throw "Provider 返回格式不符合预期。原始输出:`n$raw"
}

$timestamp = [Int64]$row["timestamp"]
$record = [ordered]@{
    source = "com.mi.health.provider.main/heartrate/recent"
    deviceSerial = $Serial
    heartRateBpm = [Int32]$row["hrm"]
    timestampMillis = $timestamp
    localTime = Convert-MillisToLocalIso -Millis $timestamp
    raw = $rowLine
}

$json = $record | ConvertTo-Json -Depth 4

Write-Host "读取成功：真实心率 $($record.heartRateBpm) bpm"
Write-Host "记录时间：$($record.localTime)"
Write-Host "来源：$($record.source)"
Write-Host ""
Write-Output $json

if ($OutputJson) {
    $json | Set-Content -LiteralPath $OutputJson -Encoding UTF8
    Write-Host ""
    Write-Host "已写入：$OutputJson"
}
