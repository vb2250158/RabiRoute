param(
    [Parameter(Mandatory = $true)]
    [string]$Serial,

    [double]$DurationHours = 24,

    [int]$SampleIntervalSeconds = 300,

    [int]$MaximumSampleAgeSeconds = 60,

    [int]$MaximumConsecutiveUnhealthySamples = 1,

    [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"
$packageName = "com.rabi.link"
$metricsFile = "shared_prefs/rabi_phone_audio_capture.xml"

if ($DurationHours -le 0) { throw "DurationHours must be greater than zero." }
if ($SampleIntervalSeconds -lt 10) { throw "SampleIntervalSeconds must be at least 10." }
if ($MaximumSampleAgeSeconds -lt 30) { throw "MaximumSampleAgeSeconds must be at least 30." }
if ($MaximumConsecutiveUnhealthySamples -lt 0) { throw "MaximumConsecutiveUnhealthySamples cannot be negative." }

$adb = (Get-Command adb -ErrorAction Stop).Source
if (-not $OutputDirectory) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $OutputDirectory = Join-Path $PSScriptRoot "..\out\mobile-audio-soak-$stamp"
}
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$samplesPath = Join-Path $OutputDirectory "samples.jsonl"
$summaryPath = Join-Path $OutputDirectory "summary.json"

function Invoke-Adb {
    param([string[]]$Arguments, [switch]$AllowFailure)
    $output = & $adb -s $Serial @Arguments 2>&1
    if ($LASTEXITCODE -ne 0 -and -not $AllowFailure) {
        throw "adb failed: $($Arguments -join ' ')`n$($output -join [Environment]::NewLine)"
    }
    return ($output -join [Environment]::NewLine)
}

function Read-CaptureMetrics {
    $raw = Invoke-Adb -Arguments @("exec-out", "run-as", $packageName, "cat", $metricsFile) -AllowFailure
    if (-not $raw -or $raw -match "run-as:|No such file|not debuggable") { return $null }
    try { [xml]$document = $raw } catch { return $null }
    $values = @{}
    foreach ($node in $document.map.ChildNodes) {
        if (-not $node.name) { continue }
        $value = if ($node.LocalName -eq "string") { $node.InnerText } else { $node.value }
        $values[$node.name] = $value
    }
    return $values
}

$device = Invoke-Adb -Arguments @("get-state")
if ($device.Trim() -ne "device") { throw "Android device $Serial is not online." }

$package = Invoke-Adb -Arguments @("shell", "pm", "path", $packageName) -AllowFailure
if ($package -notmatch "package:") { throw "$packageName is not installed on $Serial." }

$startedAt = Get-Date
$deadline = $startedAt.AddHours($DurationHours)
$samples = 0
$healthySamples = 0
$firstBytes = $null
$lastBytes = $null
$maximumObservedSampleAge = 0.0
$maximumRestartCount = 0
$consecutiveUnhealthySamples = 0
$maximumObservedUnhealthySamples = 0

while ((Get-Date) -lt $deadline) {
    $now = Get-Date
    $serviceDump = Invoke-Adb -Arguments @("shell", "dumpsys", "activity", "services", $packageName) -AllowFailure
    $serviceRunning = $serviceDump -match "RabiConversationService"
    $powerDump = Invoke-Adb -Arguments @("shell", "dumpsys", "power") -AllowFailure
    $wakeLockHeld = $powerDump -match "RabiLink:PhoneAudioCapture"
    $metrics = Read-CaptureMetrics
    $active = $false
    $lastSampleAt = 0L
    $totalBytes = 0L
    $restartCount = 0
    $state = "metrics_unavailable"
    if ($null -ne $metrics) {
        $active = "$($metrics.active)" -eq "true"
        [long]::TryParse("$($metrics.lastSampleAt)", [ref]$lastSampleAt) | Out-Null
        [long]::TryParse("$($metrics.totalBytes)", [ref]$totalBytes) | Out-Null
        [int]::TryParse("$($metrics.restartCount)", [ref]$restartCount) | Out-Null
        $state = "$($metrics.state)"
    }
    $sampleAgeSeconds = if ($lastSampleAt -gt 0) {
        [Math]::Max(0, ([DateTimeOffset]::Now.ToUnixTimeMilliseconds() - $lastSampleAt) / 1000.0)
    } else { [double]::PositiveInfinity }
    $healthy = $serviceRunning -and $wakeLockHeld -and $active -and $sampleAgeSeconds -le $MaximumSampleAgeSeconds
    if ($healthy) {
        $healthySamples += 1
        $consecutiveUnhealthySamples = 0
    } else {
        $consecutiveUnhealthySamples += 1
        $maximumObservedUnhealthySamples = [Math]::Max($maximumObservedUnhealthySamples, $consecutiveUnhealthySamples)
    }
    if ($null -eq $firstBytes -and $totalBytes -gt 0) { $firstBytes = $totalBytes }
    $lastBytes = $totalBytes
    if (-not [double]::IsInfinity($sampleAgeSeconds)) {
        $maximumObservedSampleAge = [Math]::Max($maximumObservedSampleAge, $sampleAgeSeconds)
    }
    $maximumRestartCount = [Math]::Max($maximumRestartCount, $restartCount)
    $samples += 1

    [ordered]@{
        capturedAt = $now.ToString("o")
        serviceRunning = $serviceRunning
        wakeLockHeld = $wakeLockHeld
        active = $active
        state = $state
        lastSampleAt = $lastSampleAt
        sampleAgeSeconds = if ([double]::IsInfinity($sampleAgeSeconds)) { $null } else { [Math]::Round($sampleAgeSeconds, 3) }
        totalBytes = $totalBytes
        restartCount = $restartCount
        healthy = $healthy
    } | ConvertTo-Json -Compress | Add-Content -Encoding utf8 $samplesPath

    $remaining = ($deadline - (Get-Date)).TotalSeconds
    if ($remaining -le 0) { break }
    Start-Sleep -Seconds ([Math]::Min($SampleIntervalSeconds, [Math]::Max(1, [int]$remaining)))
}

$endedAt = Get-Date
$bytesIncreased = $null -ne $firstBytes -and $null -ne $lastBytes -and $lastBytes -gt $firstBytes
$healthWithinLimit = $samples -gt 0 -and $maximumObservedUnhealthySamples -le $MaximumConsecutiveUnhealthySamples
$passed = $healthWithinLimit -and $bytesIncreased
$summary = [ordered]@{
    passed = $passed
    serial = $Serial
    packageName = $packageName
    startedAt = $startedAt.ToString("o")
    endedAt = $endedAt.ToString("o")
    requestedDurationHours = $DurationHours
    observedDurationHours = [Math]::Round(($endedAt - $startedAt).TotalHours, 4)
    samples = $samples
    healthySamples = $healthySamples
    maximumConsecutiveUnhealthySamples = $maximumObservedUnhealthySamples
    allowedConsecutiveUnhealthySamples = $MaximumConsecutiveUnhealthySamples
    maximumObservedSampleAgeSeconds = [Math]::Round($maximumObservedSampleAge, 3)
    maximumRestartCount = $maximumRestartCount
    firstObservedBytes = $firstBytes
    lastObservedBytes = $lastBytes
    bytesIncreased = $bytesIncreased
    samplesPath = $samplesPath
}
$summary | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 $summaryPath
$summary | ConvertTo-Json -Depth 4
if (-not $passed) { exit 1 }
