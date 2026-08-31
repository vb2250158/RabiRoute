param(
    [Parameter(Mandatory = $true)][string]$Serial,
    [double]$OfflineHours = 24,
    [double]$OnlineHours = 72,
    [int]$SampleIntervalSeconds = 60,
    [string]$EvidenceRoot = ""
)

$ErrorActionPreference = "Stop"
if (-not $EvidenceRoot) {
    $EvidenceRoot = Join-Path $env:LOCALAPPDATA ("RabiRoute\diagnostics\mobile-soak\durable-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
}
$EvidenceRoot = [IO.Path]::GetFullPath($EvidenceRoot)
New-Item -ItemType Directory -Force -Path $EvidenceRoot | Out-Null
$adb = Join-Path $env:LOCALAPPDATA "RabiRoute\android-sdk\platform-tools\adb.exe"
if (-not (Test-Path -LiteralPath $adb)) { $adb = (Get-Command adb -ErrorAction Stop).Source }
$networkStatePath = Join-Path $EvidenceRoot "network-state.json"
if (Test-Path -LiteralPath $networkStatePath) {
    $savedNetwork = Get-Content -LiteralPath $networkStatePath -Raw | ConvertFrom-Json
    if ($savedNetwork.serial -ne $Serial) { throw "Existing soak network identity does not match." }
    $originalWifi = "$($savedNetwork.wifi)"
    $originalData = "$($savedNetwork.mobileData)"
} else {
    $originalWifi = (& $adb -s $Serial shell settings get global wifi_on 2>$null).Trim()
    $originalData = (& $adb -s $Serial shell settings get global mobile_data 2>$null).Trim()
    [ordered]@{ schemaVersion=1; serial=$Serial; capturedAt=(Get-Date).ToString("o"); wifi=$originalWifi; mobileData=$originalData } |
        ConvertTo-Json | Set-Content -LiteralPath $networkStatePath -Encoding utf8
}

function Set-Network([bool]$Enabled) {
    $verb = if ($Enabled) { "enable" } else { "disable" }
    & $adb -s $Serial shell svc wifi $verb | Out-Null
    & $adb -s $Serial shell svc data $verb | Out-Null
}
function Restore-Network {
    & $adb -s $Serial shell svc wifi $(if ($originalWifi -eq "1") { "enable" } else { "disable" }) | Out-Null
    & $adb -s $Serial shell svc data $(if ($originalData -eq "1") { "enable" } else { "disable" }) | Out-Null
}

try {
    $offlineDirectory = Join-Path $EvidenceRoot "offline-24h"
    $offlineSummaryPath = Join-Path $offlineDirectory "summary.json"
    $offlinePassed = $false
    if (Test-Path -LiteralPath $offlineSummaryPath) {
        try { $offlinePassed = [bool](Get-Content -LiteralPath $offlineSummaryPath -Raw | ConvertFrom-Json).passed } catch { }
    }
    if (-not $offlinePassed) {
        Set-Network $false
        $offlineArguments = @{
            Serial = $Serial; Mode = "Offline"; DurationHours = $OfflineHours
            SampleIntervalSeconds = $SampleIntervalSeconds; OutputDirectory = $offlineDirectory
        }
        & (Join-Path $PSScriptRoot "Test-RabiMobileDurableAudioSoak.ps1") @offlineArguments
    }
    Restore-Network
    Start-Sleep -Seconds 30
    $onlineDirectory = Join-Path $EvidenceRoot "online-72h"
    $onlineSummaryPath = Join-Path $onlineDirectory "summary.json"
    $onlinePassed = $false
    if (Test-Path -LiteralPath $onlineSummaryPath) {
        try { $onlinePassed = [bool](Get-Content -LiteralPath $onlineSummaryPath -Raw | ConvertFrom-Json).passed } catch { }
    }
    if (-not $onlinePassed) {
        $onlineArguments = @{
            Serial = $Serial; Mode = "Online"; DurationHours = $OnlineHours
            SampleIntervalSeconds = $SampleIntervalSeconds; OutputDirectory = $onlineDirectory
        }
        & (Join-Path $PSScriptRoot "Test-RabiMobileDurableAudioSoak.ps1") @onlineArguments
    }
    $offlineSummary = Get-Content -LiteralPath $offlineSummaryPath -Raw | ConvertFrom-Json
    $onlineSummary = Get-Content -LiteralPath $onlineSummaryPath -Raw | ConvertFrom-Json
    $overallPassed = [bool]$offlineSummary.passed -and [bool]$onlineSummary.passed -and
        [bool]$onlineSummary.pendingZero -and [long]$onlineSummary.finalPendingSegments -eq 0L -and
        [bool]$onlineSummary.byteConservation -and [bool]$onlineSummary.serverExactlyOnce -and
        [bool]$onlineSummary.manifestConservation -and
        [long]$onlineSummary.capturedAccounting.pendingBytes -eq 0L -and
        [long]$onlineSummary.capturedAccounting.capturedBytes -eq
            [long]$onlineSummary.capturedAccounting.accountedCapturedBytes
    [ordered]@{
        schemaVersion = 1; passed = $overallPassed; serial = $Serial
        completedAt = (Get-Date).ToString("o"); containsPrivateAudio = $false; readsToken = $false
        offlineSummary = $offlineSummaryPath; onlineSummary = $onlineSummaryPath
        finalPendingSegments = $onlineSummary.finalPendingSegments
        capturedBytesDelta = $onlineSummary.capturedBytesDelta
        acknowledgedBytesDelta = $onlineSummary.acknowledgedBytesDelta
        serverProcessedBytesDelta = $onlineSummary.serverProcessedBytesDelta
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $EvidenceRoot "summary.json") -Encoding utf8
    if (-not $overallPassed) { throw "Durable audio soak did not reach its zero-pending conservation terminal." }
} finally {
    Restore-Network
}
