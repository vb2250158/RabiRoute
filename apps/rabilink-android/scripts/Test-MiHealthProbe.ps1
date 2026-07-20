param(
    [string]$Serial = "",
    [switch]$IncludeHealthConnect,
    [switch]$IncludeSleepHistorySearch,
    [switch]$IncludeProviderCategoryScan,
    [switch]$BuildApk
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectDir = Resolve-Path (Join-Path $scriptDir "..")
$modulePath = Join-Path $scriptDir "MiHealthProbe.psm1"

function Add-CheckResult {
    param(
        [System.Collections.Generic.List[object]]$Results,
        [string]$Name,
        [string]$Status,
        [string]$Reason = ""
    )

    $Results.Add([pscustomobject]@{
        name = $Name
        status = $Status
        reason = $Reason
    })
}

function Invoke-GradleBuild {
    param([string]$ProjectDir)

    $gradlePath = Join-Path $ProjectDir "out\tools\gradle-8.6\bin\gradle.bat"
    if (-not (Test-Path -LiteralPath $gradlePath)) {
        $gradlePath = Join-Path $env:USERPROFILE ".gradle\wrapper\dists\gradle-8.6-bin\afr5mpiioh2wthjmwnkmdsd5w\gradle-8.6\bin\gradle.bat"
    }
    if (-not (Test-Path -LiteralPath $gradlePath)) {
        throw "找不到 Gradle 8.6。当前 APK 需要 AGP 8.4.2 / Gradle 8.6 才能打包 phone.sdk.rfmlite。"
    }

    & $gradlePath -p $ProjectDir assembleDebug | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "Gradle assembleDebug 失败，退出码 $LASTEXITCODE"
    }
}

Import-Module $modulePath -Force

$results = [System.Collections.Generic.List[object]]::new()
$requiredFunctions = @(
    "Get-MiHealthSummary",
    "Get-MiHealthLatestHeartRate",
    "Get-MiHealthHeartRateAll",
    "Get-MiHealthSleepAll",
    "Search-MiHealthSleepData",
    "Test-MiHealthProviderCategories",
    "Get-MiHealthProviderDiscovery",
    "Invoke-HealthConnectProbe"
)

foreach ($functionName in $requiredFunctions) {
    if (Get-Command $functionName -ErrorAction SilentlyContinue) {
        Add-CheckResult -Results $results -Name "function:$functionName" -Status "available"
    } else {
        Add-CheckResult -Results $results -Name "function:$functionName" -Status "blocked" -Reason "模块没有导出该函数。"
    }
}

$summaryArgs = @{
    Serial = $Serial
}
if (-not $IncludeHealthConnect) {
    $summaryArgs.SkipHealthConnect = $true
}
if ($IncludeSleepHistorySearch) {
    $summaryArgs.IncludeSleepHistorySearch = $true
}
if ($IncludeProviderCategoryScan) {
    $summaryArgs.IncludeProviderCategoryScan = $true
}

$summary = Get-MiHealthSummary @summaryArgs

if ($summary.heartRate.latest.status -eq "available") {
    Add-CheckResult -Results $results -Name "heartRate.latest" -Status "available" -Reason "$($summary.heartRate.latest.bpm) bpm, $($summary.heartRate.latest.localTime)"
} else {
    Add-CheckResult -Results $results -Name "heartRate.latest" -Status $summary.heartRate.latest.status -Reason "最近一次心率不可用。"
}

if ($summary.sleep.scheduleStatus -eq "available") {
    Add-CheckResult -Results $results -Name "sleep.schedule" -Status "available"
} else {
    Add-CheckResult -Results $results -Name "sleep.schedule" -Status $summary.sleep.scheduleStatus -Reason "睡眠计划不可用。"
}

if ($summary.sleep.configStatus -eq "available") {
    Add-CheckResult -Results $results -Name "sleep.config" -Status "available"
} else {
    Add-CheckResult -Results $results -Name "sleep.config" -Status $summary.sleep.configStatus -Reason "睡眠配置不可用。"
}

Add-CheckResult -Results $results -Name "sleep.history" -Status $summary.sleep.reportSearchStatus -Reason $summary.sleep.reason
Add-CheckResult -Results $results -Name "healthConnect" -Status $summary.healthConnect.status -Reason $summary.healthConnect.reason
if ($summary.provider.healthProviderServiceStatus -eq "blocked") {
    Add-CheckResult -Results $results -Name "provider.healthProviderService" -Status "expected-blocked" -Reason $summary.provider.healthProviderServiceReason
} else {
    Add-CheckResult -Results $results -Name "provider.healthProviderService" -Status $summary.provider.healthProviderServiceStatus -Reason $summary.provider.healthProviderServiceReason
}

if ($BuildApk) {
    Invoke-GradleBuild -ProjectDir $projectDir
    Add-CheckResult -Results $results -Name "gradle.assembleDebug" -Status "available"
} else {
    Add-CheckResult -Results $results -Name "gradle.assembleDebug" -Status "skipped" -Reason "需要时加 -BuildApk。"
}

$nodeSummaryScript = Join-Path $scriptDir "read-mi-health-summary.mjs"
if (Test-Path -LiteralPath $nodeSummaryScript) {
    Add-CheckResult -Results $results -Name "node.summaryWrapper" -Status "available"
} else {
    Add-CheckResult -Results $results -Name "node.summaryWrapper" -Status "blocked" -Reason "找不到 Node 摘要包装脚本。"
}

$blockedCount = @($results | Where-Object { $_.status -eq "blocked" }).Count
$expectedBlockedCount = @($results | Where-Object { $_.status -eq "expected-blocked" }).Count
$availableCount = @($results | Where-Object { $_.status -eq "available" }).Count

[pscustomobject]@{
    source = "mi-health/probe-test"
    status = if ($blockedCount -gt 0) { "attention" } else { "ok" }
    serial = $Serial
    availableCount = $availableCount
    blockedCount = $blockedCount
    expectedBlockedCount = $expectedBlockedCount
    checks = $results
    summary = $summary
}
