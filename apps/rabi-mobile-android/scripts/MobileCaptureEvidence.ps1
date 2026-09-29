# Read only the dedicated microphone runtime preferences, never account/Relay preferences.
function Read-MobileCaptureEvidence {
    $raw = & $adb -s $Serial exec-out run-as $packageName cat shared_prefs/rabi_phone_audio_capture.xml 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $raw) { return $null }
    try {
        [xml]$document = $raw -join "`n"
        $values = @{}
        foreach ($entry in $document.map.ChildNodes) {
            if ($entry.Name -in @('boolean','long','int')) { $values[$entry.GetAttribute('name')] = $entry.GetAttribute('value') }
        }
        foreach ($key in @('active','lastSampleAt','totalBytes','startedAt')) {
            if (-not $values.ContainsKey($key)) { return $null }
        }
        return [pscustomobject]@{ active = $values.active -eq 'true'; lastSampleAt = [long]$values.lastSampleAt
            totalBytes = [long]$values.totalBytes; startedAt = [long]$values.startedAt }
    } catch { return $null }
}
function Test-MobileCaptureFresh($Evidence, [long]$NowMs, [long]$MaxAgeMs = 30000) {
    return $null -ne $Evidence -and $Evidence.active -and $Evidence.totalBytes -gt 0 -and
        $Evidence.lastSampleAt -gt 0 -and $NowMs -ge $Evidence.lastSampleAt -and
        $NowMs - $Evidence.lastSampleAt -le $MaxAgeMs
}
function Test-MobileCaptureAdvanced($Before, $After) {
    # Counter resets are not silently accepted as proof of continuous capture.
    return $null -ne $Before -and $null -ne $After -and $After.active -and
        $After.lastSampleAt -gt $Before.lastSampleAt -and $After.totalBytes -gt $Before.totalBytes
}
