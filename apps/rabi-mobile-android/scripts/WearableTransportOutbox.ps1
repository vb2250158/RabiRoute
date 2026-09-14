# Transport-only durable envelopes; never a second health timeline. No credentials persisted.
function Save-WearableTransportEnvelope {
    param($Observation, [string]$Root, [string]$TargetKey, [long]$Window)
    if ([string]::IsNullOrWhiteSpace($Root)) { throw 'OutboxRoot is required for durable health transport.' }
    New-Item -ItemType Directory -Path $Root -Force | Out-Null
    $files = @(Get-ChildItem -LiteralPath $Root -File)
    if ($files.Count -ge 2000 -or ($files | Measure-Object Length -Sum).Sum -ge 67108864) { throw 'Health transport outbox full; pending records retained.' }
    $id = [string]$Observation.Body.clientMessageId
    if ($id -notmatch '^[a-zA-Z0-9-]+$') { throw 'Invalid health envelope ID.' }
    $path = Join-Path $Root "$id.json"
    if (Test-Path -LiteralPath $path) { return }
    $payload = @{ schemaVersion = 1; targetKey = $TargetKey; windowStartedAt = $Window; observation = $Observation }
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($payload | ConvertTo-Json -Depth 16 -Compress))
    $temporary = "$path.partial"
    $stream = [IO.FileStream]::new($temporary, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    [IO.File]::Move($temporary, $path, $true)
}
function Send-WearableTransportOutbox {
    param([string]$Root, [string]$TargetKey, $Target)
    if (-not (Test-Path -LiteralPath $Root)) { return }
    foreach ($file in @(Get-ChildItem -LiteralPath $Root -Filter '*.json' -File | Sort-Object LastWriteTimeUtc)) {
        if (-not (Get-RabiLinkMobileRunPermit -ForUpload)) { return }
        try { $envelope = [IO.File]::ReadAllText($file.FullName) | ConvertFrom-Json -AsHashtable } catch { throw 'Health transport envelope invalid; retained for inspection.' }
        if ($envelope.targetKey -ne $TargetKey) { continue }
        if ([long]$envelope.windowStartedAt -le 0) { throw 'Health transport envelope missing original permit.' }
        if ($envelope.observation.Body.processingPolicy -notin @('transcribe', 'agent')) { continue }
        if ([string]::IsNullOrWhiteSpace([string]$envelope.observation.Body.routeProfileId)) { continue }
        $null = Publish-WearableObservation -Observation $envelope.observation -Target $Target
        # Receipt succeeded. A crash before deletion safely replays the frozen idempotency ID.
        [IO.File]::Delete($file.FullName)
    }
}
