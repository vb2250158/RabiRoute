. (Join-Path $PSScriptRoot 'MobileCaptureEvidence.ps1')
function Assert($Condition, $Message) { if (-not $Condition) { throw $Message } }
$a = [pscustomobject]@{ active=$true; lastSampleAt=1000L; totalBytes=32000L; startedAt=1L }
$b = [pscustomobject]@{ active=$true; lastSampleAt=2000L; totalBytes=64000L; startedAt=1L }
Assert (Test-MobileCaptureFresh $b 2100 1000) 'Fresh microphone reads must pass without any spool field.'
Assert (Test-MobileCaptureAdvanced $a $b) 'Silent PCM reads still advance capture.'
Assert (-not (Test-MobileCaptureFresh $null 2100)) 'Missing metrics are insufficient evidence.'
Assert (-not (Test-MobileCaptureFresh $a 40000)) 'Stale reads must fail.'
Assert (-not (Test-MobileCaptureAdvanced $b $a)) 'Counter rollback must not pass.'
$b.active=$false
Assert (-not (Test-MobileCaptureFresh $b 2100)) 'Paused capture must fail.'
Write-Output 'PASS: raw capture freshness/progress, silence, missing/stale/rollback/paused evidence'
