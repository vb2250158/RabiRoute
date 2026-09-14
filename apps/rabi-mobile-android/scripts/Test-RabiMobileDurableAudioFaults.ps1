param(
    [Parameter(Mandatory = $true)][string]$Serial,
    [int]$OfflineSeconds = 20,
    [int]$RecoveryTimeoutSeconds = 90,
    [string]$RabiSpeechBaseUrl = "http://127.0.0.1:8781",
    [string]$ExpectedSourceDeviceId = "rabi-phone",
    [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"
$packageName = "com.rabi.link"
$adb = Join-Path $env:LOCALAPPDATA "RabiRoute\android-sdk\platform-tools\adb.exe"
if (-not (Test-Path -LiteralPath $adb)) { $adb = (Get-Command adb -ErrorAction Stop).Source }
if ((& $adb -s $Serial get-state 2>$null).Trim() -ne "device") { throw "ADB device is not online: $Serial" }
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $env:LOCALAPPDATA ("RabiRoute\diagnostics\mobile-faults\" + (Get-Date -Format "yyyyMMdd-HHmmss"))
}
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$evidencePath = Join-Path $OutputDirectory "fault-injection.json"

function Read-State {
    $raw = & $adb -s $Serial exec-out run-as $packageName cat files/rabi-conversation/audio-spool/state.json 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $raw) { return $null }
    try { return (($raw -join "`n") | ConvertFrom-Json) } catch { return $null }
}
function Read-PartialRecoveryCount {
    $raw = & $adb -s $Serial exec-out run-as $packageName sh -c "grep -c partial_recovered files/rabi-conversation/audio-spool/audit.jsonl 2>/dev/null || true" 2>$null
    $count = 0; [int]::TryParse((($raw -join "").Trim()), [ref]$count) | Out-Null; return $count
}
function Read-Manifest {
    $directory = "files/rabi-conversation/audio-spool/segments"
    $metadataRaw = & $adb -s $Serial exec-out run-as $packageName sh -c `
        "for f in `$(find $directory -maxdepth 1 -name 'audio-*.json' 2>/dev/null | sort); do cat `$f; echo; done" 2>$null
    $shaRaw = & $adb -s $Serial exec-out run-as $packageName sh -c `
        "for f in $directory/*.pcm; do [ -f `$f ] && sha256sum `$f; done" 2>$null
    $hashes = @{}
    foreach ($line in ($shaRaw -split "`n")) {
        if ($line -match '^([0-9a-fA-F]{64})\s+.+/([^/]+\.pcm)$') { $hashes[$matches[2]] = $matches[1].ToLowerInvariant() }
    }
    $rows = @()
    foreach ($line in ($metadataRaw -split "`n")) {
        if (-not $line.Trim()) { continue }
        try { $rows += ($line | ConvertFrom-Json) } catch { }
    }
    $rows = @($rows | Sort-Object -Property sequence)
    $ids = @{}; $previous = $null; $orderValid = $true; $hashesValid = $true
    $pendingBytes = 0L; $pending = 0L; $totalBytes = 0L
    foreach ($row in $rows) {
        $id = "$($row.id)"; $sequence = [long]$row.sequence; $bytes = [long]$row.bytes
        $pcmName = [IO.Path]::GetFileName("$($row.pcmFileName)")
        $actual = if ($hashes.ContainsKey($pcmName)) { $hashes[$pcmName] } else { "" }
        if (-not $actual -or $actual -ne "$($row.sha256)".ToLowerInvariant()) { $hashesValid = $false }
        if ($ids.ContainsKey($id)) { $orderValid = $false } else { $ids[$id] = $true }
        if ($null -ne $previous -and $sequence -ne $previous + 1L) { $orderValid = $false }
        $previous = $sequence; $totalBytes += $bytes
        if ("$($row.uploadState)" -ne "acked") { $pending += 1L; $pendingBytes += $bytes }
    }
    return [ordered]@{
        metadataCount=$rows.Count; totalBytes=$totalBytes; pending=$pending; pendingBytes=$pendingBytes
        duplicateMetadataIds=$rows.Count - $ids.Count; orderValid=$orderValid; hashesValid=$hashesValid
    }
}
function Read-ServerLedger {
    try {
        $snapshot = Invoke-RestMethod -Uri "$($RabiSpeechBaseUrl.TrimEnd('/'))/v1/audio-streams" -TimeoutSec 5
        $rows = @($snapshot.durable_chunk_ledger.sources) |
            Where-Object { "$($_.source_device_id)" -like "$ExpectedSourceDeviceId*" }
        if ($rows.Count -eq 0) { return $null }
        return [ordered]@{
            processed=[long](($rows | Measure-Object processed -Sum).Sum)
            processedBytes=[long](($rows | Measure-Object processed_bytes -Sum).Sum)
            ambiguous=[long](($rows | Measure-Object ambiguous -Sum).Sum)
        }
    } catch { return $null }
}
function Test-Accounting($State, $Manifest) {
    if ($null -eq $State) { return $false }
    $accounted = [long]$State.totalAcknowledgedBytes + [long]$State.pendingBytes +
        [long]$State.activePartialBytes + [long]$State.quarantinedAudioBytes + [long]$State.capturedGapBytes
    return [bool]$State.accountingBalanced -and [long]$State.totalCapturedBytes -eq $accounted -and
        [long]$Manifest.pendingBytes -eq [long]$State.pendingBytes
}
function Set-Network([bool]$Enabled) {
    $verb = if ($Enabled) { "enable" } else { "disable" }
    & $adb -s $Serial shell svc wifi $verb | Out-Null
    & $adb -s $Serial shell svc data $verb | Out-Null
}

$wifi = (& $adb -s $Serial shell settings get global wifi_on 2>$null).Trim()
$data = (& $adb -s $Serial shell settings get global mobile_data 2>$null).Trim()
$before = Read-State
if ($null -eq $before) { throw "Durable audio state is unavailable; start voice capture first." }
$beforeRecovered = Read-PartialRecoveryCount
$beforeManifest = Read-Manifest
$offline = $null; $afterRestart = $null; $recovered = $null
$offlineManifest = [ordered]@{ metadataCount=0; duplicateMetadataIds=1; proofs=@(); hashesValid=$false }
$afterRestartManifest = [ordered]@{ metadataCount=0; duplicateMetadataIds=1; proofs=@(); hashesValid=$false }
try {
    Set-Network $false
    Start-Sleep -Seconds $OfflineSeconds
    $offline = Read-State
    $offlineManifest = Read-Manifest
    & $adb -s $Serial shell am force-stop $packageName | Out-Null
    Start-Sleep -Seconds 2
    & $adb -s $Serial shell am start -n "$packageName/.MainActivity" | Out-Null
    Start-Sleep -Seconds 8
    $afterRestart = Read-State
    $restartDeadline = (Get-Date).AddSeconds(30)
    do {
        Start-Sleep -Seconds 2
        $afterRestart = Read-State
        if ($null -ne $afterRestart -and [long]$afterRestart.lastWrittenAt -gt [long]$offline.lastWrittenAt) { break }
    } while ((Get-Date) -lt $restartDeadline)
    $afterRestartManifest = Read-Manifest
    & $adb -s $Serial shell svc wifi $(if ($wifi -eq "1") { "enable" } else { "disable" }) | Out-Null
    & $adb -s $Serial shell svc data $(if ($data -eq "1") { "enable" } else { "disable" }) | Out-Null
    $deadline = (Get-Date).AddSeconds($RecoveryTimeoutSeconds)
    do {
        Start-Sleep -Seconds 5
        $recovered = Read-State
        if ($null -ne $recovered -and [long]$recovered.lastUploadedAt -gt [long]$before.lastUploadedAt -and
            [long]$recovered.pendingSegments -eq 0L) { break }
    } while ((Get-Date) -lt $deadline)
} finally {
    & $adb -s $Serial shell svc wifi $(if ($wifi -eq "1") { "enable" } else { "disable" }) | Out-Null
    & $adb -s $Serial shell svc data $(if ($data -eq "1") { "enable" } else { "disable" }) | Out-Null
}

$afterRecovered = Read-PartialRecoveryCount
$recoveredManifest = Read-Manifest
$serverLedger = Read-ServerLedger
$offlineCaptureAdvanced = $null -ne $offline -and [long]$offline.nextSequence -gt [long]$before.nextSequence
$restartSequenceMonotonic = $null -ne $afterRestart -and [long]$afterRestart.nextSequence -ge [long]$offline.nextSequence
$partialRecovered = $afterRecovered -gt $beforeRecovered
$uploadRecovered = $null -ne $recovered -and [long]$recovered.lastUploadedAt -gt [long]$before.lastUploadedAt -and
    [long]$recovered.pendingSegments -eq 0L
$restartCaptureActive = $null -ne $afterRestart -and [long]$afterRestart.lastWrittenAt -gt [long]$offline.lastWrittenAt
$manifestValid = $beforeManifest.hashesValid -and $offlineManifest.hashesValid -and
    $afterRestartManifest.hashesValid -and $recoveredManifest.hashesValid -and
    $beforeManifest.orderValid -and $offlineManifest.orderValid -and
    $afterRestartManifest.orderValid -and $recoveredManifest.orderValid -and
    $beforeManifest.duplicateMetadataIds -eq 0 -and
    $offlineManifest.duplicateMetadataIds -eq 0 -and $afterRestartManifest.duplicateMetadataIds -eq 0
$byteConservation = (Test-Accounting $offline $offlineManifest) -and
    (Test-Accounting $afterRestart $afterRestartManifest) -and
    (Test-Accounting $recovered $recoveredManifest)
$serverExactlyOnce = $null -ne $serverLedger -and [long]$serverLedger.ambiguous -eq 0L -and
    [long]$serverLedger.processed -eq [long]$recovered.totalAcknowledgedSegments -and
    [long]$serverLedger.processedBytes -eq [long]$recovered.totalAcknowledgedBytes
$passed = $offlineCaptureAdvanced -and $restartSequenceMonotonic -and $restartCaptureActive -and
    $partialRecovered -and $uploadRecovered -and $manifestValid -and $byteConservation -and $serverExactlyOnce
[ordered]@{
    passed = $passed; serial = $Serial; capturedAt = (Get-Date).ToString("o")
    offlineSeconds = $OfflineSeconds; recoveryTimeoutSeconds = $RecoveryTimeoutSeconds
    offlineCaptureAdvanced = $offlineCaptureAdvanced
    restartSequenceMonotonic = $restartSequenceMonotonic
    restartCaptureActive = $restartCaptureActive
    partialRecovered = $partialRecovered; uploadRecovered = $uploadRecovered
    finalPendingSegments = if ($null -ne $recovered) { $recovered.pendingSegments } else { $null }
    manifestValid = $manifestValid; byteConservation = $byteConservation; serverExactlyOnce = $serverExactlyOnce
    beforeManifest = $beforeManifest; offlineManifest = $offlineManifest
    afterRestartManifest = $afterRestartManifest; recoveredManifest = $recoveredManifest
    serverLedger = $serverLedger
    beforeNextSequence = $before.nextSequence; offlineNextSequence = $offline.nextSequence
    afterRestartNextSequence = $afterRestart.nextSequence
    beforeLastUploadedAt = $before.lastUploadedAt; recoveredLastUploadedAt = $recovered.lastUploadedAt
    beforePartialRecoveryCount = $beforeRecovered; afterPartialRecoveryCount = $afterRecovered
    containsPrivateAudio = $false; readsToken = $false
} | ConvertTo-Json -Depth 5 | Tee-Object -FilePath $evidencePath
if (-not $passed) { exit 1 }
