$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../apps/rabi-mobile-android/scripts/WearableTransportOutbox.ps1')
$root = Join-Path ([IO.Path]::GetTempPath()) ('wearable-test-' + [guid]::NewGuid())
$script:uploads = 0; $script:permit = $false; $script:fail = $true
function Get-RabiLinkMobileRunPermit { param([switch]$ForUpload); return $script:permit }
function Publish-WearableObservation { param($Observation,$Target); if($script:fail){throw 'offline'}; $script:uploads++ }
try {
 $observation = @{ Body = @{ processingPolicy='transcribe'; routeProfileId='test'; clientMessageId='wearable-test-1'; capturedAt=123; health=@{samples=@(@{id='sample-1'})} } }
 Save-WearableTransportEnvelope $observation $root 'manager-role:test' 100
 Save-WearableTransportEnvelope $observation $root 'manager-role:test' 100
 if(@(Get-ChildItem $root -Filter '*.json').Count -ne 1){throw 'duplicate'}
 Send-WearableTransportOutbox $root 'manager-role:test' @{}
 if($script:uploads -ne 0){throw 'disabled upload'}
 $script:permit=$true
 try { Send-WearableTransportOutbox $root 'manager-role:test' @{} } catch {}
 if(@(Get-ChildItem $root -Filter '*.json').Count -ne 1){throw 'offline lost record'}
 $script:fail=$false
 Send-WearableTransportOutbox $root 'manager-role:other' @{}
 if($script:uploads -ne 0){throw 'retargeted'}
 Send-WearableTransportOutbox $root 'manager-role:test' @{}
 if($script:uploads -ne 1 -or @(Get-ChildItem $root -Filter '*.json').Count -ne 0){throw 'ack cleanup'}
 'PASS: durable replay, disabled upload, endpoint isolation, idempotency and ACK cleanup'
} finally { if(Test-Path $root){Remove-Item $root -Recurse -Force} }
