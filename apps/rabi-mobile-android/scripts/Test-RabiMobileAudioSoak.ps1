param(
    [string]$Serial = "",

    [double]$DurationHours = 24,

    [int]$SampleIntervalSeconds = 300,

    [int]$MaximumSampleAgeSeconds = 60,

    [int]$MaximumConsecutiveUnhealthySamples = 1,

    [string]$RabiSpeechBaseUrl = "http://127.0.0.1:8781",

    [string]$ExpectedSourceDeviceId = "rabi-phone",

    [int]$RequestTimeoutSeconds = 5,

    [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"
$packageName = "com.rabi.link"
$metricsFile = "shared_prefs/rabi_phone_audio_capture.xml"

if ($DurationHours -le 0) { throw "DurationHours must be greater than zero." }
if ($SampleIntervalSeconds -lt 10) { throw "SampleIntervalSeconds must be at least 10." }
if ($MaximumSampleAgeSeconds -lt 30) { throw "MaximumSampleAgeSeconds must be at least 30." }
if ($MaximumConsecutiveUnhealthySamples -lt 0) { throw "MaximumConsecutiveUnhealthySamples cannot be negative." }
if ($RequestTimeoutSeconds -lt 1) { throw "RequestTimeoutSeconds must be at least 1." }

$adbCommand = Get-Command adb -ErrorAction SilentlyContinue
$adb = if ($null -ne $adbCommand) { $adbCommand.Source } else { "" }
$RabiSpeechBaseUrl = $RabiSpeechBaseUrl.TrimEnd("/")
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
    if (-not $adb -or -not $Serial) {
        if ($AllowFailure) { return "" }
        throw "ADB or Android serial is unavailable."
    }
    $output = & $adb -s $Serial @Arguments 2>&1
    if ($LASTEXITCODE -ne 0 -and -not $AllowFailure) {
        throw "adb failed: $($Arguments -join ' ')`n$($output -join [Environment]::NewLine)"
    }
    return ($output -join [Environment]::NewLine)
}

function Test-AdbOnline {
    if (-not $adb -or -not $Serial) { return $false }
    $state = Invoke-Adb -Arguments @("get-state") -AllowFailure
    return $state.Trim() -eq "device"
}

function Read-CaptureMetrics {
    if (-not (Test-AdbOnline)) { return $null }
    $raw = Invoke-Adb -Arguments @("exec-out", "run-as", $packageName, "cat", $metricsFile) -AllowFailure
    if (-not $raw -or $raw -match "run-as:|No such file|not debuggable|device offline") { return $null }
    try { [xml]$document = $raw } catch { return $null }
    $values = @{}
    foreach ($node in $document.map.ChildNodes) {
        if (-not $node.name) { continue }
        $value = if ($node.LocalName -eq "string") { $node.InnerText } else { $node.value }
        $values[$node.name] = $value
    }
    return $values
}

function Read-AudioStreamStatus {
    try {
        $snapshot = Invoke-RestMethod -Uri "$RabiSpeechBaseUrl/v1/audio-streams" -TimeoutSec $RequestTimeoutSeconds
        $clients = @($snapshot.clients)
        $client = $null
        if ($ExpectedSourceDeviceId) {
            $client = $clients | Where-Object {
                "$($_.source_device_id)" -eq $ExpectedSourceDeviceId
            } | Select-Object -First 1
        }
        if ($null -eq $client) {
            $client = $clients | Where-Object { $_.selected -eq $true } | Select-Object -First 1
        }
        if ($null -eq $client -and $snapshot.selected_client_id) {
            $client = $clients | Where-Object {
                "$($_.id)" -eq "$($snapshot.selected_client_id)"
            } | Select-Object -First 1
        }
        if ($null -eq $client) {
            return [pscustomobject]@{
                available = $true
                online = $false
                captureEnabled = $snapshot.capture_enabled -eq $true
                error = "selected_client_missing"
            }
        }

        $lastAudioAt = 0.0
        [double]::TryParse("$($client.last_audio_at)", [ref]$lastAudioAt) | Out-Null
        $audioAgeSeconds = if ($lastAudioAt -gt 0) {
            [Math]::Max(0, [DateTimeOffset]::Now.ToUnixTimeMilliseconds() / 1000.0 - $lastAudioAt)
        } else { [double]::PositiveInfinity }
        $receivedBytes = $null
        if ($null -ne $client.received_bytes) {
            $parsedBytes = 0L
            if ([long]::TryParse("$($client.received_bytes)", [ref]$parsedBytes)) {
                $receivedBytes = $parsedBytes
            }
        }
        $acceptedChunks = $null
        if ($null -ne $client.accepted_chunks) {
            $parsedChunks = 0L
            if ([long]::TryParse("$($client.accepted_chunks)", [ref]$parsedChunks)) {
                $acceptedChunks = $parsedChunks
            }
        }
        $lastSequence = $null
        if ($null -ne $client.last_sequence) {
            $parsedSequence = 0L
            if ([long]::TryParse("$($client.last_sequence)", [ref]$parsedSequence)) {
                $lastSequence = $parsedSequence
            }
        }
        $sampleRate = 0
        [int]::TryParse("$($client.sample_rate)", [ref]$sampleRate) | Out-Null
        $chunkMs = 0
        [int]::TryParse("$($client.chunk_ms)", [ref]$chunkMs) | Out-Null
        $observedPcmBytes = $receivedBytes
        $pcmByteCounterSource = if ($null -ne $receivedBytes) { "received_bytes" } else { "" }
        if ($null -eq $observedPcmBytes -and $null -ne $lastSequence -and $sampleRate -gt 0 -and $chunkMs -gt 0) {
            $bytesPerChunk = [long]([Math]::Round($sampleRate * $chunkMs / 1000.0) * 2)
            $observedPcmBytes = [long]$lastSequence * $bytesPerChunk
            $pcmByteCounterSource = "sequence_estimate"
        }

        return [pscustomobject]@{
            available = $true
            online = $client.online -eq $true
            captureEnabled = $snapshot.capture_enabled -eq $true
            clientId = "$($client.id)"
            sourceDeviceId = "$($client.source_device_id)"
            routeProfileId = "$($client.route_profile_id)"
            connectedAt = [double]$client.connected_at
            lastAudioAt = $lastAudioAt
            audioAgeSeconds = $audioAgeSeconds
            lastSequence = $lastSequence
            sampleRate = $sampleRate
            chunkMs = $chunkMs
            receivedBytes = $receivedBytes
            observedPcmBytes = $observedPcmBytes
            pcmByteCounterSource = $pcmByteCounterSource
            acceptedChunks = $acceptedChunks
            error = ""
        }
    } catch {
        return [pscustomobject]@{
            available = $false
            online = $false
            captureEnabled = $false
            error = $_.Exception.Message
        }
    }
}

$startedAt = Get-Date
$deadline = $startedAt.AddHours($DurationHours)
$samples = 0
$healthySamples = 0
$adbOnlineSamples = 0
$adbMetricsSamples = 0
$firstPhoneBytes = $null
$lastPhoneBytes = $null
$firstPcmBytes = $null
$lastPcmBytes = $null
$previousPcmBytes = $null
$observedPcmByteGrowth = 0L
$pcmCounterResetCount = 0
$maximumObservedSampleAge = 0.0
$maximumRestartCount = 0
$consecutiveUnhealthySamples = 0
$maximumObservedUnhealthySamples = 0
$streamRecoveryCount = 0
$streamReconnectCount = 0
$pcmByteCounterSources = [System.Collections.Generic.HashSet[string]]::new()
$previousStreamHealthy = $null
$previousConnectionIdentity = ""
$fatalError = ""

try {
    while ((Get-Date) -lt $deadline) {
        $now = Get-Date
        $stream = Read-AudioStreamStatus
        $streamAgeSeconds = if ($null -ne $stream.audioAgeSeconds) {
            [double]$stream.audioAgeSeconds
        } else { [double]::PositiveInfinity }
        $healthy = $stream.online -and $stream.captureEnabled -and $streamAgeSeconds -le $MaximumSampleAgeSeconds

        if ($healthy) {
            $healthySamples += 1
            $consecutiveUnhealthySamples = 0
        } else {
            $consecutiveUnhealthySamples += 1
            $maximumObservedUnhealthySamples = [Math]::Max(
                $maximumObservedUnhealthySamples,
                $consecutiveUnhealthySamples
            )
        }
        if ($previousStreamHealthy -eq $false -and $healthy) {
            $streamRecoveryCount += 1
        }
        $previousStreamHealthy = $healthy

        $connectionIdentity = if ($stream.clientId) {
            "$($stream.clientId)|$($stream.connectedAt)"
        } else { "" }
        if ($previousConnectionIdentity -and $connectionIdentity -and $connectionIdentity -ne $previousConnectionIdentity) {
            $streamReconnectCount += 1
        }
        if ($connectionIdentity) { $previousConnectionIdentity = $connectionIdentity }

        if ($null -ne $stream.observedPcmBytes) {
            $currentPcmBytes = [long]$stream.observedPcmBytes
            if ($stream.pcmByteCounterSource) {
                $pcmByteCounterSources.Add("$($stream.pcmByteCounterSource)") | Out-Null
            }
            if ($null -eq $firstPcmBytes) { $firstPcmBytes = $currentPcmBytes }
            if ($null -ne $previousPcmBytes) {
                if ($currentPcmBytes -ge $previousPcmBytes) {
                    $observedPcmByteGrowth += $currentPcmBytes - $previousPcmBytes
                } else {
                    $pcmCounterResetCount += 1
                }
            }
            $previousPcmBytes = $currentPcmBytes
            $lastPcmBytes = $currentPcmBytes
        }
        if (-not [double]::IsInfinity($streamAgeSeconds)) {
            $maximumObservedSampleAge = [Math]::Max($maximumObservedSampleAge, $streamAgeSeconds)
        }

        $adbOnline = Test-AdbOnline
        $serviceRunning = $null
        $wakeLockHeld = $null
        $active = $null
        $lastSampleAt = $null
        $phoneSampleAgeSeconds = $null
        $totalBytes = $null
        $restartCount = $null
        $state = "adb_unavailable"
        if ($adbOnline) {
            $adbOnlineSamples += 1
            $serviceDump = Invoke-Adb -Arguments @("shell", "dumpsys", "activity", "services", $packageName) -AllowFailure
            $serviceRunning = $serviceDump -match "RabiConversationService"
            $powerDump = Invoke-Adb -Arguments @("shell", "dumpsys", "power") -AllowFailure
            $wakeLockHeld = $powerDump -match "RabiLink:PhoneAudioCapture"
            $metrics = Read-CaptureMetrics
            if ($null -ne $metrics) {
                $adbMetricsSamples += 1
                $active = "$($metrics.active)" -eq "true"
                $parsedLastSampleAt = 0L
                $parsedTotalBytes = 0L
                $parsedRestartCount = 0
                [long]::TryParse("$($metrics.lastSampleAt)", [ref]$parsedLastSampleAt) | Out-Null
                [long]::TryParse("$($metrics.totalBytes)", [ref]$parsedTotalBytes) | Out-Null
                [int]::TryParse("$($metrics.restartCount)", [ref]$parsedRestartCount) | Out-Null
                $lastSampleAt = $parsedLastSampleAt
                $totalBytes = $parsedTotalBytes
                $restartCount = $parsedRestartCount
                $state = "$($metrics.state)"
                $phoneSampleAgeSeconds = if ($parsedLastSampleAt -gt 0) {
                    [Math]::Max(
                        0,
                        ([DateTimeOffset]::Now.ToUnixTimeMilliseconds() - $parsedLastSampleAt) / 1000.0
                    )
                } else { $null }
                if ($null -eq $firstPhoneBytes -and $parsedTotalBytes -gt 0) {
                    $firstPhoneBytes = $parsedTotalBytes
                }
                $lastPhoneBytes = $parsedTotalBytes
                $maximumRestartCount = [Math]::Max($maximumRestartCount, $parsedRestartCount)
            } else {
                $state = "metrics_unavailable"
            }
        }

        $samples += 1
        [ordered]@{
            capturedAt = $now.ToString("o")
            healthy = $healthy
            streamAvailable = $stream.available
            streamOnline = $stream.online
            captureEnabled = $stream.captureEnabled
            streamError = $stream.error
            clientId = $stream.clientId
            sourceDeviceId = $stream.sourceDeviceId
            routeProfileId = $stream.routeProfileId
            connectedAt = $stream.connectedAt
            lastAudioAt = $stream.lastAudioAt
            audioAgeSeconds = if ([double]::IsInfinity($streamAgeSeconds)) {
                $null
            } else { [Math]::Round($streamAgeSeconds, 3) }
            lastSequence = $stream.lastSequence
            sampleRate = $stream.sampleRate
            chunkMs = $stream.chunkMs
            receivedPcmBytes = $stream.receivedBytes
            observedPcmBytes = $stream.observedPcmBytes
            pcmByteCounterSource = $stream.pcmByteCounterSource
            acceptedPcmChunks = $stream.acceptedChunks
            adbOnline = $adbOnline
            serviceRunning = $serviceRunning
            wakeLockHeld = $wakeLockHeld
            active = $active
            state = $state
            lastSampleAt = $lastSampleAt
            phoneSampleAgeSeconds = if ($null -eq $phoneSampleAgeSeconds) {
                $null
            } else { [Math]::Round($phoneSampleAgeSeconds, 3) }
            phoneTotalBytes = $totalBytes
            phoneRestartCount = $restartCount
        } | ConvertTo-Json -Compress | Add-Content -Encoding utf8 $samplesPath

        $remaining = ($deadline - (Get-Date)).TotalSeconds
        if ($remaining -le 0) { break }
        Start-Sleep -Seconds ([Math]::Min($SampleIntervalSeconds, [Math]::Max(1, [int]$remaining)))
    }
} catch {
    $fatalError = $_.Exception.Message
}

$endedAt = Get-Date
$pcmBytesIncreased = $observedPcmByteGrowth -gt 0
$phoneBytesIncreased = (
    $null -ne $firstPhoneBytes -and
    $null -ne $lastPhoneBytes -and
    $lastPhoneBytes -gt $firstPhoneBytes
)
$healthWithinLimit = (
    $samples -gt 0 -and
    $maximumObservedUnhealthySamples -le $MaximumConsecutiveUnhealthySamples
)
$durationCompleted = $endedAt -ge $deadline.AddSeconds(-1)
$passed = (
    -not $fatalError -and
    $durationCompleted -and
    $healthWithinLimit -and
    $pcmBytesIncreased
)
$summary = [ordered]@{
    passed = $passed
    serial = $Serial
    packageName = $packageName
    rabiSpeechBaseUrl = $RabiSpeechBaseUrl
    expectedSourceDeviceId = $ExpectedSourceDeviceId
    startedAt = $startedAt.ToString("o")
    endedAt = $endedAt.ToString("o")
    requestedDurationHours = $DurationHours
    observedDurationHours = [Math]::Round(($endedAt - $startedAt).TotalHours, 4)
    durationCompleted = $durationCompleted
    samples = $samples
    healthySamples = $healthySamples
    maximumConsecutiveUnhealthySamples = $maximumObservedUnhealthySamples
    allowedConsecutiveUnhealthySamples = $MaximumConsecutiveUnhealthySamples
    maximumObservedSampleAgeSeconds = [Math]::Round($maximumObservedSampleAge, 3)
    firstObservedPcmBytes = $firstPcmBytes
    lastObservedPcmBytes = $lastPcmBytes
    observedPcmByteGrowth = $observedPcmByteGrowth
    pcmBytesIncreased = $pcmBytesIncreased
    pcmByteCounterSources = @($pcmByteCounterSources)
    pcmCounterResetCount = $pcmCounterResetCount
    streamRecoveryCount = $streamRecoveryCount
    streamReconnectCount = $streamReconnectCount
    adbOnlineSamples = $adbOnlineSamples
    adbMetricsSamples = $adbMetricsSamples
    maximumRestartCount = $maximumRestartCount
    firstObservedPhoneBytes = $firstPhoneBytes
    lastObservedPhoneBytes = $lastPhoneBytes
    phoneBytesIncreased = $phoneBytesIncreased
    fatalError = $fatalError
    samplesPath = $samplesPath
}
$summary | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 $summaryPath
$summary | ConvertTo-Json -Depth 5
if (-not $passed) { exit 1 }
