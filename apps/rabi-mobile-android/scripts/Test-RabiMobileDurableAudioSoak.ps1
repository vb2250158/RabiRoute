param(
    [Parameter(Mandatory = $true)][string]$Serial,
    [ValidateSet("Offline", "Online")][string]$Mode = "Online",
    [double]$DurationHours = 72,
    [int]$SampleIntervalSeconds = 60,
    [string]$RabiSpeechBaseUrl = "http://127.0.0.1:8781",
    [string]$ExpectedSourceDeviceId = "rabi-phone",
    [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"
$packageName = "com.rabi.link"
$localAdb = Join-Path $env:LOCALAPPDATA "RabiRoute\android-sdk\platform-tools\adb.exe"
$adb = if (Test-Path -LiteralPath $localAdb) { $localAdb } else { (Get-Command adb -ErrorAction Stop).Source }
if ($DurationHours -le 0) { throw "DurationHours must be greater than zero." }
if ($SampleIntervalSeconds -lt 10) { throw "SampleIntervalSeconds must be at least 10." }
$ackJournalRetentionHours = 96
$ackJournalSafetyHours = 24
if ($DurationHours + $ackJournalSafetyHours -gt $ackJournalRetentionHours) {
    throw "DurationHours plus the acknowledgement-journal safety margin must not exceed 96 hours."
}
if ((& $adb -s $Serial get-state 2>$null).Trim() -ne "device") { throw "ADB device is not online: $Serial" }

if (-not $OutputDirectory) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $OutputDirectory = Join-Path $env:LOCALAPPDATA "RabiRoute\diagnostics\mobile-soak\$stamp-$($Mode.ToLowerInvariant())"
}
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$runPath = Join-Path $OutputDirectory "run.json"
$samplesPath = Join-Path $OutputDirectory "samples.jsonl"
$summaryPath = Join-Path $OutputDirectory "summary.json"
$phoneTuplePath = Join-Path $OutputDirectory "phone-acknowledged-tuples.json"
$serverTuplePath = Join-Path $OutputDirectory "server-terminal-tuples.json"
$tupleParityScript = Join-Path $PSScriptRoot "rabi-mobile-tuple-parity.mjs"
$node = (Get-Command node -ErrorAction Stop).Source
if (-not (Test-Path -LiteralPath $tupleParityScript)) { throw "Tuple parity validator is missing: $tupleParityScript" }

function Invoke-AdbText([string[]]$Arguments) {
    $value = & $adb -s $Serial @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "ADB command failed: $($Arguments -join ' ')" }
    return ($value -join "`n").Trim()
}

function Read-AckJournal([long]$AfterSourceSequence) {
    $directory = "files/rabi-conversation/audio-spool/ack-journal"
    $raw = Invoke-AdbText @("exec-out", "run-as", $packageName, "sh", "-c",
        "for f in `$(find $directory -maxdepth 1 -name 'ack-*.json' 2>/dev/null | sort); do cat `$f; echo; done")
    $records = New-Object System.Collections.Generic.List[object]
    $maximum = 0L; $previous = 0L; $parseErrors = 0
    foreach ($line in ($raw -split "`n")) {
        if (-not $line.Trim()) { continue }
        try { $record = $line | ConvertFrom-Json -ErrorAction Stop } catch { $parseErrors += 1; continue }
        if ($null -eq $record -or -not $record.chunkId -or $null -eq $record.acceptedBytes -or
            -not $record.sha256 -or $null -eq $record.sourceSequence -or
            $null -eq $record.serverSequence -or $null -eq $record.ackedAt -or -not $record.source) {
            throw "Phone acknowledgement journal contains a null record or missing tuple field."
        }
        $sequence = [long]$record.sourceSequence
        if ($sequence -le 0L -or ($previous -gt 0L -and $sequence -le $previous)) {
            throw "Phone acknowledgement journal order is invalid at source sequence $sequence."
        }
        $previous = $sequence; $maximum = [Math]::Max($maximum, $sequence)
        if ($sequence -le $AfterSourceSequence) { continue }
        $records.Add([ordered]@{
            source = "$($record.source)"; sourceSequence = $sequence
            streamSequence = [long]$record.serverSequence; chunkId = "$($record.chunkId)"
            acceptedBytes = [long]$record.acceptedBytes; sha256 = "$($record.sha256)".ToLowerInvariant()
            ackedAt = [long]$record.ackedAt; terminal = $true; terminalStatus = "processed"
        })
    }
    if ($parseErrors -gt 0) { throw "Phone acknowledgement journal contains $parseErrors invalid JSON record(s)." }
    return [ordered]@{
        afterSourceSequence = $AfterSourceSequence; maxSourceSequence = $maximum
        records = @($records); retentionHours = 96; capacityRecords = 100000
        capacityBytes = 134217728
    }
}

function Read-SpoolState {
    $raw = Invoke-AdbText @("exec-out", "run-as", $packageName, "cat", "files/rabi-conversation/audio-spool/state.json")
    if (-not $raw -or $raw -match "run-as:|No such file") { throw "Phone spool state is missing or empty." }
    try { return $raw | ConvertFrom-Json -ErrorAction Stop } catch { throw "Phone spool state JSON is invalid: $($_.Exception.Message)" }
}

function Read-SpoolCounts {
    $script = "d=files/rabi-conversation/audio-spool/segments; " +
        "printf 'metadata='; find `$d -maxdepth 1 -name '*.json' 2>/dev/null | wc -l; " +
        "printf 'sealed='; find `$d -maxdepth 1 -name '*.pcm' 2>/dev/null | wc -l; " +
        "printf 'partial='; find `$d -maxdepth 1 -name '*.partial' 2>/dev/null | wc -l"
    $raw = Invoke-AdbText @("exec-out", "run-as", $packageName, "sh", "-c", $script)
    $result = @{ metadata = 0; sealed = 0; partial = 0 }
    foreach ($line in ($raw -split "`n")) {
        if ($line -match "^(metadata|sealed|partial)=(\d+)$") { $result[$matches[1]] = [int]$matches[2] }
    }
    return $result
}

function Read-SegmentProof([string]$MetadataPath) {
    if (-not $MetadataPath) { throw "Segment proof metadata path is null." }
    $raw = Invoke-AdbText @("exec-out", "run-as", $packageName, "cat", $MetadataPath)
    if (-not $raw) { throw "Segment proof metadata is null: $MetadataPath" }
    try { $metadata = $raw | ConvertFrom-Json -ErrorAction Stop } catch {
        throw "Segment proof JSON is invalid at $MetadataPath`: $($_.Exception.Message)"
    }
    if (-not $metadata.id -or $null -eq $metadata.sequence -or $null -eq $metadata.bytes -or -not $metadata.sha256) {
        throw "Segment proof JSON is missing required tuple fields: $MetadataPath"
    }
    $pcmName = [IO.Path]::GetFileName("$($metadata.pcmFileName)")
    if (-not $pcmName) { return $null }
    $pcmPath = "files/rabi-conversation/audio-spool/segments/$pcmName"
    $actual = Invoke-AdbText @("exec-out", "run-as", $packageName, "sha256sum", $pcmPath)
    $actualHash = if ($actual -match "^([0-9a-fA-F]{64})\s") { $matches[1].ToLowerInvariant() } else { "" }
    return [ordered]@{
        id = "$($metadata.id)"; sequence = [long]$metadata.sequence; bytes = [long]$metadata.bytes
        uploadState = "$($metadata.uploadState)"; serverSequence = [long]$metadata.serverSequence
        declaredSha256 = "$($metadata.sha256)".ToLowerInvariant(); actualSha256 = $actualHash
        hashMatches = $actualHash -and $actualHash -eq "$($metadata.sha256)".ToLowerInvariant()
    }
}

function Read-SpoolManifest {
    $directory = "files/rabi-conversation/audio-spool/segments"
    $raw = Invoke-AdbText @("exec-out", "run-as", $packageName, "sh", "-c",
        "find $directory -maxdepth 1 -name 'audio-*.json' 2>/dev/null | sort")
    $paths = @($raw -split "`n" | Where-Object { $_ -match 'audio-\d+\.json$' })
    $duplicateIds = @($paths | ForEach-Object { [IO.Path]::GetFileName($_) } | Group-Object | Where-Object Count -gt 1).Count
    $manifest = [ordered]@{
        metadataCount = $paths.Count
        duplicateMetadataIds = $duplicateIds
        head = if ($paths.Count -gt 0) { Read-SegmentProof $paths[0] } else { $null }
        tail = if ($paths.Count -gt 1) { Read-SegmentProof $paths[-1] } elseif ($paths.Count -eq 1) { Read-SegmentProof $paths[0] } else { $null }
    }
    if ($null -eq $manifest) { throw "Phone spool manifest is null." }
    if ($paths.Count -gt 0 -and ($null -eq $manifest.head -or $null -eq $manifest.tail)) {
        throw "Phone spool manifest head or tail proof is null."
    }
    return $manifest
}

function Read-FinalManifestProof {
    $directory = "files/rabi-conversation/audio-spool/segments"
    $metadataRaw = Invoke-AdbText @("exec-out", "run-as", $packageName, "sh", "-c",
        "for f in `$(find $directory -maxdepth 1 -name 'audio-*.json' 2>/dev/null | sort); do cat `$f; echo; done")
    $shaRaw = Invoke-AdbText @("exec-out", "run-as", $packageName, "sh", "-c",
        "for f in $directory/*.pcm; do [ -f `$f ] && sha256sum `$f; done")
    $actualHashes = @{}
    foreach ($line in ($shaRaw -split "`n")) {
        if ($line -match '^([0-9a-fA-F]{64})\s+.+/([^/]+\.pcm)$') {
            $actualHashes[$matches[2]] = $matches[1].ToLowerInvariant()
        }
    }
    $rows = @(); $parseErrors = 0
    foreach ($line in ($metadataRaw -split "`n")) {
        if (-not $line.Trim()) { continue }
        try { $rows += ($line | ConvertFrom-Json -ErrorAction Stop) } catch { $parseErrors += 1 }
    }
    if ($parseErrors -gt 0) { throw "Final phone manifest contains $parseErrors invalid JSON record(s)." }
    $rows = @($rows | Sort-Object -Property sequence)
    $ids = @{}; $previous = $null; $orderValid = $true; $hashesValid = $true
    $totalBytes = 0L; $pendingBytes = 0L; $ackedBytes = 0L; $pending = 0L; $acked = 0L
    $tuples = New-Object System.Collections.Generic.List[string]
    foreach ($row in $rows) {
        if ($null -eq $row -or -not $row.id -or $null -eq $row.sequence -or $null -eq $row.bytes -or
            -not $row.sha256 -or -not $row.pcmFileName -or -not $row.uploadState) {
            throw "Final phone manifest contains a null record or missing tuple field."
        }
        $sequence = [long]$row.sequence; $id = "$($row.id)"; $bytes = [long]$row.bytes
        $pcmName = [IO.Path]::GetFileName("$($row.pcmFileName)")
        $actual = if ($actualHashes.ContainsKey($pcmName)) { $actualHashes[$pcmName] } else { "" }
        $declared = "$($row.sha256)".ToLowerInvariant()
        if (-not $actual -or $actual -ne $declared) { $hashesValid = $false }
        if ($ids.ContainsKey($id)) { $orderValid = $false } else { $ids[$id] = $true }
        if ($null -ne $previous -and $sequence -ne $previous + 1L) { $orderValid = $false }
        $previous = $sequence; $totalBytes += $bytes
        if ("$($row.uploadState)" -eq "acked") {
            $acked += 1L; $ackedBytes += $bytes
        }
        else { $pending += 1L; $pendingBytes += $bytes }
        $tuples.Add("$sequence|$id|$bytes|$declared|$($row.uploadState)|$($row.serverSequence)")
    }
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        $manifestBytes = [Text.Encoding]::UTF8.GetBytes(($tuples -join "`n"))
        $manifestSha = ([BitConverter]::ToString($hasher.ComputeHash($manifestBytes))).Replace("-", "").ToLowerInvariant()
    } finally { $hasher.Dispose() }
    return [ordered]@{
        records = $rows.Count; totalBytes = $totalBytes; pendingBytes = $pendingBytes
        acknowledgedBytes = $ackedBytes; pending = $pending; acknowledged = $acked
        orderValid = $orderValid; hashesValid = $hashesValid; manifestSha256 = $manifestSha
        firstSequence = if ($rows.Count -gt 0) { [long]$rows[0].sequence } else { $null }
        lastSequence = if ($rows.Count -gt 0) { [long]$rows[-1].sequence } else { $null }
        containsPrivateAudio = $false
    }
}

function Read-OnlineAck {
    if ($Mode -ne "Online") { return $null }
    $snapshot = Invoke-RestMethod -Uri "$($RabiSpeechBaseUrl.TrimEnd('/'))/v1/audio-streams" -TimeoutSec 5
    if ($null -eq $snapshot -or $null -eq $snapshot.durable_chunk_ledger) { throw "RabiSpeech ledger snapshot is null." }
    $client = @($snapshot.clients) | Where-Object { "$($_.source_device_id)" -like "$ExpectedSourceDeviceId*" } |
        Sort-Object -Property last_audio_at -Descending | Select-Object -First 1
    if ($null -eq $client -or -not $client.source_device_id) { throw "No matching online RabiLink phone source was found." }
    $ledgers = @($snapshot.durable_chunk_ledger.sources) |
        Where-Object { "$($_.source_device_id)" -eq "$($client.source_device_id)" }
    $ledger = if ($ledgers.Count -eq 1) { [pscustomobject]@{
        processed = [long]$ledgers[0].processed
        processed_bytes = [long]$ledgers[0].processed_bytes
        ambiguous = [long]$ledgers[0].ambiguous
        source_count = 1
    } } else { throw "Expected exactly one durable ledger for source $($client.source_device_id), found $($ledgers.Count)." }
    return [ordered]@{ client = $client; ledger = $ledger }
}

function Read-ServerTupleManifest([string]$SourceDeviceId, [long]$FirstSequence, [long]$LastSequence) {
    if (-not $SourceDeviceId) { throw "Server tuple source device id is null." }
    $records = New-Object System.Collections.Generic.List[object]
    $after = [Math]::Max(0L, $FirstSequence - 1L)
    while ($true) {
        $source = [Uri]::EscapeDataString($SourceDeviceId)
        $uri = "$($RabiSpeechBaseUrl.TrimEnd('/'))/v1/audio-streams/rabilink/ledger/tuples?sourceDeviceId=$source&afterSourceSequence=$after&limit=1000"
        $page = Invoke-RestMethod -Uri $uri -TimeoutSec 10
        if ($null -eq $page -or $null -eq $page.records) { throw "Server tuple page is null after source sequence $after." }
        foreach ($record in @($page.records)) {
            if ($null -eq $record) { throw "Server tuple page contains a null record." }
            $sequence = [long]$record.source_sequence
            if ($sequence -gt $LastSequence) { break }
            $records.Add([ordered]@{
                sourceDeviceId = "$($record.source_device_id)"; sourceSequence = $sequence
                streamSequence = [long]$record.stream_sequence; chunkId = "$($record.chunk_id)"
                acceptedBytes = [long]$record.accepted_bytes; sha256 = "$($record.sha256)".ToLowerInvariant()
                terminal = [bool]$record.terminal; terminalStatus = "$($record.terminal_status)"
            })
        }
        if (-not [bool]$page.has_more -or [long]$page.next_after_source_sequence -ge $LastSequence) { break }
        $next = [long]$page.next_after_source_sequence
        if ($next -le $after) { throw "Server tuple pagination did not advance after source sequence $after." }
        $after = $next
    }
    return @($records)
}

if (Test-Path -LiteralPath $runPath) {
    try { $run = Get-Content -LiteralPath $runPath -Raw | ConvertFrom-Json -ErrorAction Stop } catch {
        throw "Existing soak run JSON is invalid: $($_.Exception.Message)"
    }
    if ($run.serial -ne $Serial -or $run.mode -ne $Mode) { throw "Existing soak identity does not match." }
    if ($null -eq $run.ackJournalWatermark) { throw "Existing soak run is missing its acknowledgement-journal watermark." }
    $startedAt = [DateTimeOffset]::Parse($run.startedAt)
    $deadline = [DateTimeOffset]::Parse($run.deadline)
    $ackJournalWatermark = [long]$run.ackJournalWatermark
} else {
    $startedAt = [DateTimeOffset]::Now
    $deadline = $startedAt.AddHours($DurationHours)
    $journalAtStart = Read-AckJournal 0L
    $stateAtStart = Read-SpoolState
    if ($null -eq $stateAtStart.acknowledgedAccountingSequence) {
        throw "Phone spool state is missing its durable ACK watermark."
    }
    $ackJournalWatermark = [long]$stateAtStart.acknowledgedAccountingSequence
    $journalMaximumAtStart = [long]$journalAtStart.maxSourceSequence
    $journalCutoffAtStart = [DateTimeOffset]::Now.ToUnixTimeMilliseconds() -
        [long]($ackJournalRetentionHours * 60 * 60 * 1000)
    if (($journalMaximumAtStart -gt 0L -and $journalMaximumAtStart -ne $ackJournalWatermark) -or
        ($journalMaximumAtStart -eq 0L -and [long]$stateAtStart.lastUploadedAt -ge $journalCutoffAtStart)) {
        throw "Phone acknowledgement journal does not cover the current durable ACK watermark."
    }
    [ordered]@{
        schemaVersion = 2; serial = $Serial; mode = $Mode
        startedAt = $startedAt.ToString("o"); deadline = $deadline.ToString("o")
        requestedDurationHours = $DurationHours; sampleIntervalSeconds = $SampleIntervalSeconds
        ackJournalWatermark = $ackJournalWatermark; ackJournalRetentionHours = 96
        ackJournalCapacityRecords = 100000; ackJournalCapacityBytes = 134217728
        containsPrivateAudio = $false; readsToken = $false
    } | ConvertTo-Json | Set-Content -LiteralPath $runPath -Encoding utf8
}

$first = $null
$last = $null
$samples = 0
$unhealthy = 0
while ([DateTimeOffset]::Now -lt $deadline) {
    $now = [DateTimeOffset]::Now
    $state = Read-SpoolState
    $counts = Read-SpoolCounts
    $manifest = Read-SpoolManifest
    $server = Read-OnlineAck
    $lastWrittenAt = if ($null -ne $state) { [long]$state.lastWrittenAt } else { 0L }
    $lastUploadedAt = if ($null -ne $state) { [long]$state.lastUploadedAt } else { 0L }
    $writeAge = if ($lastWrittenAt -gt 0) { [Math]::Max(0, $now.ToUnixTimeMilliseconds() - $lastWrittenAt) } else { [long]::MaxValue }
    $service = Invoke-AdbText @("shell", "dumpsys", "activity", "services", $packageName)
    $manifestHealthy = $manifest.duplicateMetadataIds -eq 0 -and
        ($null -eq $manifest.head -or $manifest.head.hashMatches) -and
        ($null -eq $manifest.tail -or $manifest.tail.hashMatches) -and
        $manifest.metadataCount -eq $counts.metadata -and $counts.metadata -eq $counts.sealed
    $healthy = $null -ne $state -and $writeAge -le [Math]::Max(30000, $SampleIntervalSeconds * 2000) -and
        $service -match "RabiConversationService" -and $manifestHealthy
    if ($Mode -eq "Online") { $healthy = $healthy -and $lastUploadedAt -gt 0 }
    if (-not $healthy) { $unhealthy += 1 }
    $row = [ordered]@{
        capturedAt = $now.ToString("o"); mode = $Mode; healthy = $healthy
        lastCapturedAt = if ($null -ne $state) { $state.lastCapturedAt } else { $null }
        lastWrittenAt = $lastWrittenAt; lastUploadedAt = $lastUploadedAt
        nextSequence = if ($null -ne $state) { $state.nextSequence } else { $null }
        rejectedBytes = if ($null -ne $state) { $state.rejectedBytes } else { $null }
        uncapturedGapBytes = if ($null -ne $state) { $state.uncapturedGapBytes } else { $null }
        lastFailure = if ($null -ne $state) { $state.lastFailure } else { "state_unavailable" }
        metadataFiles = $counts.metadata; sealedFiles = $counts.sealed; partialFiles = $counts.partial
        manifest = $manifest; manifestHealthy = $manifestHealthy
        pendingSegments = if ($null -ne $state) { $state.pendingSegments } else { $null }
        pendingBytes = if ($null -ne $state) { $state.pendingBytes } else { $null }
        activePartialBytes = if ($null -ne $state) { $state.activePartialBytes } else { $null }
        acknowledgedSegments = if ($null -ne $state) { $state.acknowledgedSegments } else { $null }
        storedBytes = if ($null -ne $state) { $state.storedBytes } else { $null }
        quarantineItems = if ($null -ne $state) { $state.quarantineItems } else { $null }
        quarantineBytes = if ($null -ne $state) { $state.quarantineBytes } else { $null }
        totalCapturedBytes = if ($null -ne $state) { $state.totalCapturedBytes } else { $null }
        totalAcknowledgedBytes = if ($null -ne $state) { $state.totalAcknowledgedBytes } else { $null }
        totalAcknowledgedSegments = if ($null -ne $state) { $state.totalAcknowledgedSegments } else { $null }
        acknowledgedAccountingSequence = if ($null -ne $state) { $state.acknowledgedAccountingSequence } else { $null }
        quarantinedAudioBytes = if ($null -ne $state) { $state.quarantinedAudioBytes } else { $null }
        capturedGapBytes = if ($null -ne $state) { $state.capturedGapBytes } else { $null }
        accountedCapturedBytes = if ($null -ne $state) { $state.accountedCapturedBytes } else { $null }
        accountingBalanced = if ($null -ne $state) { $state.accountingBalanced } else { $false }
        serverSourceDeviceId = if ($null -ne $server.client) { $server.client.source_device_id } else { $null }
        serverLastSequence = if ($null -ne $server.client) { $server.client.last_sequence } else { $null }
        serverLastAudioAt = if ($null -ne $server.client) { $server.client.last_audio_at } else { $null }
        serverProcessedChunks = if ($null -ne $server.ledger) { $server.ledger.processed } else { $null }
        serverProcessedBytes = if ($null -ne $server.ledger) { $server.ledger.processed_bytes } else { $null }
        serverAmbiguousChunks = if ($null -ne $server.ledger) { $server.ledger.ambiguous } else { $null }
    }
    $row | ConvertTo-Json -Compress | Add-Content -LiteralPath $samplesPath -Encoding utf8
    if ($null -eq $first) { $first = $row }
    $last = $row; $samples += 1
    $remaining = ($deadline - [DateTimeOffset]::Now).TotalSeconds
    if ($remaining -le 0) { break }
    Start-Sleep -Seconds ([Math]::Min($SampleIntervalSeconds, [Math]::Max(1, [int]$remaining)))
}

$completed = [DateTimeOffset]::Now -ge $deadline.AddSeconds(-1)
$captureAdvanced = $null -ne $first -and $null -ne $last -and [long]$last.nextSequence -gt [long]$first.nextSequence
$uploadAdvanced = $Mode -eq "Offline" -or ($null -ne $first -and $null -ne $last -and [long]$last.lastUploadedAt -gt [long]$first.lastUploadedAt)
$pendingZero = $Mode -eq "Offline" -or ($null -ne $last -and [long]$last.pendingSegments -eq 0L)
$finalManifestProof = Read-FinalManifestProof
$runAckJournal = Read-AckJournal $ackJournalWatermark
$phoneAcknowledgedTuples = @($runAckJournal.records)
if ($Mode -eq "Online") {
    if ([long]$runAckJournal.maxSourceSequence -lt $ackJournalWatermark) {
        throw "Phone acknowledgement journal maximum moved behind the frozen run watermark."
    }
    if ($null -eq $last -or $null -eq $last.acknowledgedAccountingSequence -or
        [long]$runAckJournal.maxSourceSequence -ne [long]$last.acknowledgedAccountingSequence) {
        throw "Phone acknowledgement journal does not reach the final durable ACK watermark."
    }
}
$accountedCapturedBytes = if ($null -ne $last) {
    [long]$last.totalAcknowledgedBytes + [long]$last.pendingBytes + [long]$last.activePartialBytes +
        [long]$last.quarantinedAudioBytes + [long]$last.capturedGapBytes
} else { -1L }
$byteConservation = $null -ne $last -and [bool]$last.accountingBalanced -and
    [long]$last.totalCapturedBytes -eq $accountedCapturedBytes -and
    [long]$finalManifestProof.pendingBytes -eq [long]$last.pendingBytes
$serverExactlyOnce = $Mode -eq "Offline" -or ($null -ne $last -and
    $null -ne $last.serverProcessedChunks -and $null -ne $last.serverProcessedBytes -and
    [long]$last.serverAmbiguousChunks -eq 0L -and
    [long]$last.serverProcessedChunks -eq [long]$last.totalAcknowledgedSegments -and
    [long]$last.serverProcessedBytes -eq [long]$last.totalAcknowledgedBytes)
$tupleParity = $null
if ($Mode -eq "Online") {
    if ($phoneAcknowledgedTuples.Count -eq 0) { throw "Final phone manifest has no acknowledged tuples to compare." }
    $actualSourceDeviceId = "$($last.serverSourceDeviceId)"
    if (-not $actualSourceDeviceId) { throw "Final server source device id is null." }
    foreach ($tuple in $phoneAcknowledgedTuples) { $tuple["sourceDeviceId"] = $actualSourceDeviceId }
    $lastAcknowledgedSequence = [long]$phoneAcknowledgedTuples[-1].sourceSequence
    $serverTuples = Read-ServerTupleManifest $actualSourceDeviceId ($ackJournalWatermark + 1L) $lastAcknowledgedSequence
    ConvertTo-Json -InputObject @($phoneAcknowledgedTuples) -Depth 4 |
        Set-Content -LiteralPath $phoneTuplePath -Encoding utf8
    ConvertTo-Json -InputObject @($serverTuples) -Depth 4 |
        Set-Content -LiteralPath $serverTuplePath -Encoding utf8
    $tupleParityRaw = & $node $tupleParityScript $phoneTuplePath $serverTuplePath 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Per-tuple exactly-once validation failed: $($tupleParityRaw -join ' ')" }
    try { $tupleParity = ($tupleParityRaw -join "`n") | ConvertFrom-Json -ErrorAction Stop } catch {
        throw "Tuple parity validator returned invalid JSON: $($_.Exception.Message)"
    }
    if ($null -eq $tupleParity -or -not [bool]$tupleParity.matched) { throw "Tuple parity validator returned null or unmatched." }
}
$perTupleExactlyOnce = $Mode -eq "Offline" -or ($null -ne $tupleParity -and [bool]$tupleParity.matched)
$manifestConservation = $finalManifestProof.orderValid -and $finalManifestProof.hashesValid -and
    ($Mode -eq "Offline" -or [long]$finalManifestProof.pending -eq 0L)
$passed = $completed -and $captureAdvanced -and $uploadAdvanced -and $unhealthy -eq 0 -and
    $pendingZero -and $byteConservation -and $serverExactlyOnce -and $perTupleExactlyOnce -and $manifestConservation
[ordered]@{
    passed = $passed; completed = $completed; mode = $Mode; serial = $Serial
    startedAt = $startedAt.ToString("o"); endedAt = [DateTimeOffset]::Now.ToString("o")
    deadline = $deadline.ToString("o"); samples = $samples; unhealthySamples = $unhealthy
    captureAdvanced = $captureAdvanced; uploadAdvanced = $uploadAdvanced
    pendingZero = $pendingZero; byteConservation = $byteConservation; serverExactlyOnce = $serverExactlyOnce
    perTupleExactlyOnce = $perTupleExactlyOnce; tupleParity = $tupleParity
    ackJournal = [ordered]@{
        watermark = $ackJournalWatermark; finalMaxSourceSequence = [long]$runAckJournal.maxSourceSequence
        runRecords = $phoneAcknowledgedTuples.Count; retentionHours = [long]$runAckJournal.retentionHours
        capacityRecords = [long]$runAckJournal.capacityRecords; capacityBytes = [long]$runAckJournal.capacityBytes
    }
    capturedAccounting = [ordered]@{
        capturedBytes = if ($null -ne $last) { [long]$last.totalCapturedBytes } else { $null }
        acknowledgedBytes = if ($null -ne $last) { [long]$last.totalAcknowledgedBytes } else { $null }
        pendingBytes = if ($null -ne $last) { [long]$last.pendingBytes } else { $null }
        activePartialBytes = if ($null -ne $last) { [long]$last.activePartialBytes } else { $null }
        quarantinedAudioBytes = if ($null -ne $last) { [long]$last.quarantinedAudioBytes } else { $null }
        capturedGapBytes = if ($null -ne $last) { [long]$last.capturedGapBytes } else { $null }
        uncapturedGapBytes = if ($null -ne $last) { [long]$last.uncapturedGapBytes } else { $null }
        accountedCapturedBytes = if ($null -ne $last) { $accountedCapturedBytes } else { $null }
        identity = "captured = acknowledged + pending + activePartial + quarantinedAudio + capturedGap"
    }
    manifestConservation = $manifestConservation; finalManifestProof = $finalManifestProof
    finalPendingSegments = if ($null -ne $last) { $last.pendingSegments } else { $null }
    capturedBytesDelta = if ($null -ne $first -and $null -ne $last) { [long]$last.totalCapturedBytes - [long]$first.totalCapturedBytes } else { $null }
    acknowledgedBytesDelta = if ($null -ne $first -and $null -ne $last) { [long]$last.totalAcknowledgedBytes - [long]$first.totalAcknowledgedBytes } else { $null }
    serverProcessedBytesDelta = if ($Mode -eq "Online" -and $null -ne $first -and $null -ne $last) { [long]$last.serverProcessedBytes - [long]$first.serverProcessedBytes } else { $null }
    firstNextSequence = if ($null -ne $first) { $first.nextSequence } else { $null }
    lastNextSequence = if ($null -ne $last) { $last.nextSequence } else { $null }
    firstUploadedAt = if ($null -ne $first) { $first.lastUploadedAt } else { $null }
    lastUploadedAt = if ($null -ne $last) { $last.lastUploadedAt } else { $null }
    samplesPath = $samplesPath
    phoneTuplePath = if ($Mode -eq "Online") { $phoneTuplePath } else { $null }
    serverTuplePath = if ($Mode -eq "Online") { $serverTuplePath } else { $null }
} | ConvertTo-Json -Depth 5 | Tee-Object -FilePath $summaryPath
if (-not $passed) { exit 1 }
