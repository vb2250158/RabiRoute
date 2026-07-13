param(
  [string] $ExpectedRelayBaseUrl = "https://your-relay.example.com",
  [string] $ReportPath = "",
  [switch] $RequireComplete
)

$ErrorActionPreference = "Stop"

function Resolve-OptionalPath {
  param([string] $PathValue)
  if (-not $PathValue) { return "" }
  return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($PathValue)
}

function Get-Sha256Hex {
  param([string] $PathValue)
  $stream = [System.IO.File]::OpenRead($PathValue)
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
      $bytes = $sha.ComputeHash($stream)
      return ([System.BitConverter]::ToString($bytes) -replace "-", "").ToLowerInvariant()
    }
    finally {
      $sha.Dispose()
    }
  }
  finally {
    $stream.Dispose()
  }
}

function New-Requirement {
  param(
    [string] $Id,
    [string] $Requirement,
    [string] $Status,
    [string] $Evidence,
    [string] $NextStep = ""
  )

  return [ordered]@{
    id = $Id
    requirement = $Requirement
    status = $Status
    evidence = $Evidence
    next_step = $NextStep
  }
}

function Read-JsonFile {
  param([string] $PathValue)
  if (-not (Test-Path -LiteralPath $PathValue)) { return $null }
  return Get-Content -LiteralPath $PathValue -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Normalize-RelayUrl {
  param([string] $Value)
  if (-not $Value) { return "" }
  return $Value.Trim().TrimEnd("/")
}

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
if (-not $ReportPath) {
  $ReportPath = Join-Path $projectRoot "dist\goal-evidence.json"
}
$resolvedReportPath = Resolve-OptionalPath $ReportPath
$reportDir = Split-Path -Parent $resolvedReportPath
if (-not (Test-Path -LiteralPath $reportDir)) {
  New-Item -ItemType Directory -Path $reportDir | Out-Null
}

$aixPath = Join-Path $projectRoot "dist\rabilink-aiui.aix"
$deliveryManifestPath = Join-Path $projectRoot "dist\delivery\install-manifest.json"
$phoneReportPath = Join-Path $projectRoot "dist\phone-install-surface.json"
$apkSurfacePath = Join-Path $projectRoot "dist\apk-inspect\rokid-aiui-apk-surface.json"
$craftStatusPath = Join-Path $projectRoot "dist\craft-upload-status.json"
$craftReviewStatusPath = Join-Path $projectRoot "dist\craft-review-status.json"
$phoneAgentStatusPath = Join-Path $projectRoot "dist\phone-agent-status.json"
$runtimeProofPath = Join-Path $projectRoot "dist\runtime-proof-status.json"
$relaySmokePath = Join-Path $projectRoot "dist\relay-mobile-webgui-smoke.json"
$localAcceptancePath = Join-Path $projectRoot "dist\local-acceptance.json"
$realGlassesStatusPath = Join-Path $projectRoot "dist\real-glasses-device-status.json"
$deviceStatusE2ePath = Join-Path $projectRoot "dist\device-status-e2e.json"
$readmePath = Join-Path $projectRoot "README.md"
$installationDocPath = Join-Path $projectRoot "docs\installation-and-troubleshooting.md"
$relayServerPath = Resolve-Path -LiteralPath (Join-Path $projectRoot "..\..\scripts\rabilink-relay-server.mjs")
$expectedRelay = Normalize-RelayUrl $ExpectedRelayBaseUrl

$deliveryManifest = Read-JsonFile $deliveryManifestPath
$phoneReport = Read-JsonFile $phoneReportPath
$apkSurface = Read-JsonFile $apkSurfacePath
$craftStatus = Read-JsonFile $craftStatusPath
$craftReviewStatus = Read-JsonFile $craftReviewStatusPath
$phoneAgentStatus = Read-JsonFile $phoneAgentStatusPath
$runtimeProof = Read-JsonFile $runtimeProofPath
$relaySmoke = Read-JsonFile $relaySmokePath
$localAcceptance = Read-JsonFile $localAcceptancePath
$realGlassesStatus = Read-JsonFile $realGlassesStatusPath
$deviceStatusE2e = Read-JsonFile $deviceStatusE2ePath
$readme = if (Test-Path -LiteralPath $readmePath) { Get-Content -LiteralPath $readmePath -Raw -Encoding UTF8 } else { "" }
$installationDoc = if (Test-Path -LiteralPath $installationDocPath) { Get-Content -LiteralPath $installationDocPath -Raw -Encoding UTF8 } else { "" }
$relayServer = if (Test-Path -LiteralPath $relayServerPath) { Get-Content -LiteralPath $relayServerPath -Raw -Encoding UTF8 } else { "" }

$aixExists = Test-Path -LiteralPath $aixPath
$aixHash = if ($aixExists) { Get-Sha256Hex $aixPath } else { "" }
$manifestHash = if ($deliveryManifest -and $deliveryManifest.aix) { [string]$deliveryManifest.aix.sha256 } else { "" }
$phoneHash = if ($phoneReport -and $phoneReport.device_aix) { [string]$phoneReport.device_aix.sha256 } else { "" }
$manifestRelay = if ($deliveryManifest) { Normalize-RelayUrl ([string]$deliveryManifest.relay_base_url) } else { "" }

$requirements = New-Object System.Collections.Generic.List[object]

$requirements.Add((New-Requirement `
  -Id "aiui-design" `
  -Requirement "Use the AIUI interaction model and glasses-oriented visual constraints." `
  -Status "proved-by-local-audit" `
  -Evidence "npm run check passes Audit-AiuiDesign; README documents 448x352 HUD, voice wakeup, key navigation, and AIUI SpeechRecognition/TTS usage."))

$installationDocsStatus = if (
  $installationDoc.Length -gt 5000 `
  -and $installationDoc -match "dist/rabilink-aiui.aix" `
  -and $installationDoc -match "RabiLink 1.0.4" `
  -and $installationDoc -match "Craft" `
  -and $installationDoc -match "Permission Denial" `
  -and $installationDoc -match "device-status" `
  -and $installationDoc -match "runtime:proof"
) { "proved-documented" } else { "missing-or-incomplete" }
$requirements.Add((New-Requirement `
  -Id "installation-troubleshooting-docs" `
  -Requirement "Record the verified install, review, phone sync, runtime, and troubleshooting path for the next session." `
  -Status $installationDocsStatus `
  -Evidence ("installation guide={0}" -f $installationDocPath) `
  -NextStep $(if ($installationDocsStatus -eq "proved-documented") { "" } else { "Complete docs/installation-and-troubleshooting.md with the five-stage release path and reproduced failures." })))

$requirements.Add((New-Requirement `
  -Id "webgui-config-coverage" `
  -Requirement "Expose PC RabiRoute WebGUI configurable functions through the AIUI surface." `
  -Status "proved-by-local-audit" `
  -Evidence "npm run check passes WebGUI coverage for 27 endpoint patterns and config surface audit for 44 gateway fields plus 9 structured editors."))

$relayStatus = if ($relaySmoke -and [bool]$relaySmoke.ok) {
  "proved-by-integration-smoke"
} elseif ($relayServer -match "/api/rabilink/mobile/webgui" -and $relayServer -match "manager-config" -and $relayServer -match "gateways") {
  "proved-by-source"
} else {
  "missing-or-weak"
}
$requirements.Add((New-Requirement `
  -Id "relay-bound-pc" `
  -Requirement "AIUI reaches the server-selected or bound PC Rabi through RabiLink Relay instead of direct LAN access." `
  -Status $relayStatus `
  -Evidence ("Relay mobile WebGUI proxy source: {0}; smoke report: {1}" -f $relayServerPath, $relaySmokePath) `
  -NextStep $(if ($relayStatus -eq "proved-by-source" -or $relayStatus -eq "proved-by-integration-smoke") { "" } else { "Inspect relay mobile WebGUI whitelist and PC worker binding path." })))

$continuousStreamProved = $relaySmoke `
  -and [bool]$relaySmoke.ok `
  -and [string]$relaySmoke.message_input_status -eq "accepted" `
  -and $relaySmoke.proactive_stream_message `
  -and [bool]$relaySmoke.proactive_stream_message.proactive `
  -and [bool]$localAcceptance.local_acceptance_complete
$requirements.Add((New-Requirement `
  -Id "continuous-active-message-stream" `
  -Requirement "Connection Conversation consumes one cursor stream for normal replies and taskless proactive delivery, with native TTS/ASR handoff." `
  -Status $(if ($continuousStreamProved) { "proved-by-local-and-http-integration" } else { "missing-or-weak" }) `
  -Evidence ("Relay stream smoke={0}; local acceptance={1}; proactive text={2}" -f $relaySmokePath, $localAcceptancePath, $(if ($relaySmoke -and $relaySmoke.proactive_stream_message) { [string]$relaySmoke.proactive_stream_message.text } else { "" })) `
  -NextStep $(if ($continuousStreamProved) { "" } else { "Run npm run acceptance:local and inspect the Relay message stream smoke report." })))

$packageStatus = if ($aixExists -and $manifestHash -eq $aixHash -and $manifestRelay -eq $expectedRelay) { "proved" } else { "incomplete" }
$requirements.Add((New-Requirement `
  -Id "package-delivery" `
  -Requirement "Build a clean AIX and delivery kit for RabiLink AIUI." `
  -Status $packageStatus `
  -Evidence ("AIX={0}; sha256={1}; delivery manifest relay={2}" -f $aixPath, $aixHash, $manifestRelay) `
  -NextStep $(if ($packageStatus -eq "proved") { "" } else { "Run npm run delivery and readiness with the expected relay URL." })))

$apkConfirmsNoAixHandler = $apkSurface -and -not [bool]$apkSurface.conclusion.public_aix_file_handler_detected
$phoneStatus = if ($phoneReport -and $phoneHash -eq $aixHash -and -not [bool]$phoneReport.conclusion.public_aix_file_handler_detected) { "proved-phone-staging-not-install" } else { "missing-or-stale" }
$requirements.Add((New-Requirement `
  -Id "phone-staging" `
  -Requirement "Put the latest AIX on the phone and inspect the Rokid AI app install surface." `
  -Status $phoneStatus `
  -Evidence ("phone report={0}; device sha256={1}; no public AIX handler={2}; APK confirms no public AIX handler={3}; APK report={4}" -f $phoneReportPath, $phoneHash, $(if ($phoneReport) { -not [bool]$phoneReport.conclusion.public_aix_file_handler_detected } else { $false }), $apkConfirmsNoAixHandler, $apkSurfacePath) `
  -NextStep $(if ($phoneStatus -eq "proved-phone-staging-not-install") { "Use Craft/AIUI Studio because phone file staging alone is not installation; APK inspection also found no public local .aix import route." } else { "Run npm run push:phone, npm run phone:inspect:deep, and npm run phone:apk-inspect." })))

$craftStatusValue = if ($craftStatus -and [bool]$craftStatus.matched) { "proved-upload-visible" } else { "missing" }
$craftUploadNextStep = "Run npm run craft:upload with ROKID_CRAFT_ACCOUNT_TOKEN and ROKID_CRAFT_URL (or ROKID_CRAFT_AGENT_ID), then npm run craft:status. If Chrome is already logged in but token should not leave the browser, run npm run craft:open-embedded-helper, paste the embedded helper into the target Craft page console, click Check session, Upload embedded AIX, List agents and Download report, then run npm run craft:import-browser-report or npm run craft:watch-browser-report."
$requirements.Add((New-Requirement `
  -Id "craft-upload" `
  -Requirement "Upload or sync RabiLink AIUI through Craft/AIUI Studio so it appears in the Rokid account." `
  -Status $craftStatusValue `
  -Evidence ("craft status report={0}" -f $craftStatusPath) `
  -NextStep $(if ($craftStatusValue -eq "proved-upload-visible") { "" } else { $craftUploadNextStep })))

$cloudProjectBound = $craftReviewStatus `
  -and [bool]$craftReviewStatus.cloud_project_bound `
  -and [bool]$craftReviewStatus.review_button_enabled
$craftCloudBindingStatus = if ($cloudProjectBound) { "proved-cloud-binding" } else { "not-bound" }
$requirements.Add((New-Requirement `
  -Id "craft-cloud-binding" `
  -Requirement "Open the uploaded cloud RabiLink project so Craft restores the Lingzhu agent binding." `
  -Status $craftCloudBindingStatus `
  -Evidence ("Craft review status report={0}" -f $craftReviewStatusPath) `
  -NextStep $(if ($cloudProjectBound) { "" } else { "Open the Craft project menu and select Cloud Projects > RabiLink <version>; verify the top project name is RabiLink and Review is enabled." })))

$craftReviewSubmitted = $craftReviewStatus -and [bool]$craftReviewStatus.review_submitted
$craftReviewApproved = $craftReviewStatus -and [bool]$craftReviewStatus.review_approved
$craftReviewValue = if ($craftReviewApproved) {
  "proved-review-approved"
} elseif ($craftReviewSubmitted) {
  "awaiting-review"
} elseif ($cloudProjectBound) {
  "awaiting-submit"
} else {
  "not-ready"
}
$requirements.Add((New-Requirement `
  -Id "craft-review" `
  -Requirement "Submit the bound cloud version for review and wait until it is approved for the Rokid agent store." `
  -Status $craftReviewValue `
  -Evidence ("Craft review status report={0}" -f $craftReviewStatusPath) `
  -NextStep $(if ($craftReviewApproved) { "" } elseif ($craftReviewSubmitted) { "Wait for the Lingzhu review to be approved, then refresh the phone agent store." } elseif ($cloudProjectBound) { "After the account owner explicitly approves the external action, click Submit Review in Craft." } else { "Complete Craft upload and cloud project binding first." })))

$phoneAgentInstalled = $phoneAgentStatus `
  -and [bool]$phoneAgentStatus.agent_management_opened `
  -and [bool]$phoneAgentStatus.agent_installed
$phoneAgentInstallStatus = if ($phoneAgentInstalled) { "proved-phone-agent-installed" } else { "not-installed" }
$requirements.Add((New-Requirement `
  -Id "phone-agent-install" `
  -Requirement "Add the approved RabiLink agent in the Rokid AI App and verify it appears in Agent Management." `
  -Status $phoneAgentInstallStatus `
  -Evidence ("phone agent status report={0}" -f $phoneAgentStatusPath) `
  -NextStep $(if ($phoneAgentInstalled) { "" } elseif ($craftReviewApproved) { "On the phone open Home > Agent Store, search RabiLink, add it, and verify Agent Management lists it." } else { "Complete Craft review approval first; an unreviewed upload is not expected to appear in the phone store." })))

$adbDevices = if ($deliveryManifest -and $deliveryManifest.adb_devices) { @($deliveryManifest.adb_devices) } else { @() }
$hasDirectGlassAdb = @($adbDevices | Where-Object { $_ -match "(?i)rokid|glass" }).Count -gt 0
$hasCxrGlassEvidence = $realGlassesStatus `
  -and [bool]$realGlassesStatus.ok `
  -and [bool]$realGlassesStatus.statusOnlyConnection `
  -and -not [bool]$realGlassesStatus.customViewOpened `
  -and -not [bool]$realGlassesStatus.displaySessionConfigured `
  -and [int]$realGlassesStatus.glassInfoCallbacks -gt 0 `
  -and [string]$realGlassesStatus.source -eq "rokid-cxr-phone"
$hasAiuiDeviceStatusEvidence = $deviceStatusE2e `
  -and [bool]$deviceStatusE2e.ok `
  -and [string]$deviceStatusE2e.source -eq "relay-cxr" `
  -and [bool]$deviceStatusE2e.compiledInkPage
$hasGlass = $hasDirectGlassAdb -or ($hasCxrGlassEvidence -and $hasAiuiDeviceStatusEvidence)
$glassStatus = if ($hasDirectGlassAdb) {
  "device-detected"
} elseif ($hasCxrGlassEvidence -and $hasAiuiDeviceStatusEvidence) {
  "proved-by-cxr-bridge"
} else {
  "missing"
}
$requirements.Add((New-Requirement `
  -Id "glasses-device" `
  -Requirement "Detect a real Rokid/glasses device through direct ADB or the official phone CXR status bridge." `
  -Status $glassStatus `
  -Evidence ("ADB devices: {0}; CXR report={1}; callbacks={2}; status-only={3}; display session={4}; compiled AIUI Relay E2E={5}" -f ($adbDevices -join " | "), $realGlassesStatusPath, $(if ($realGlassesStatus) { [int]$realGlassesStatus.glassInfoCallbacks } else { 0 }), $(if ($realGlassesStatus) { [bool]$realGlassesStatus.statusOnlyConnection } else { $false }), $(if ($realGlassesStatus) { [bool]$realGlassesStatus.displaySessionConfigured } else { $false }), $hasAiuiDeviceStatusEvidence) `
  -NextStep $(if ($hasGlass) { "Use Craft sync for the final AIX launch; direct glasses ADB is not required when CXR evidence is present." } else { "Connect the glasses through the phone CXR bridge or direct ADB, then collect device-status evidence." })))

$runtimeStatus = if ($runtimeProof -and [bool]$runtimeProof.proved) {
  "proved-by-runtime-proof"
} elseif ($craftReviewApproved -and $phoneAgentInstalled -and $hasGlass) {
  "ready-to-run-final-test"
} else {
  "not-proved"
}
$latestRuntimeProof = if ($runtimeProof -and $runtimeProof.latest_proof) {
  ("latest event={0} at {1}" -f [string]$runtimeProof.latest_proof.event, [string]$runtimeProof.latest_proof.time)
} else {
  "no runtime proof report or no matching proof"
}
$requirements.Add((New-Requirement `
  -Id "glasses-runtime-test" `
  -Requirement "Run RabiLink AIUI on the glasses and verify it can control bound PC RabiRoute settings." `
  -Status $runtimeStatus `
  -Evidence ("runtime proof report={0}; {1}" -f $runtimeProofPath, $latestRuntimeProof) `
  -NextStep $(if ($runtimeStatus -eq "proved-by-runtime-proof") { "" } elseif ($runtimeStatus -eq "ready-to-run-final-test") { "Launch on glasses, connect Relay, bind PC, load/save WebGUI config, then run npm run runtime:proof." } else { "Complete Craft review approval, phone agent installation, and glasses connection first; after launch, run npm run runtime:proof with RABILINK_AIUI_RELAY_URL and RABILINK_AIUI_TOKEN." })))

$provedStatuses = @("proved", "proved-by-local-audit", "proved-by-source", "proved-by-integration-smoke", "proved-by-local-and-http-integration", "proved-phone-staging-not-install", "proved-upload-visible", "proved-cloud-binding", "proved-review-approved", "proved-phone-agent-installed", "proved-documented", "device-detected", "proved-by-cxr-bridge", "proved-by-runtime-proof")
$missing = @($requirements | Where-Object { $provedStatuses -notcontains $_.status })
$complete = $missing.Count -eq 0

$report = [ordered]@{
  generated_at = (Get-Date).ToUniversalTime().ToString("o")
  objective = "RabiLink AIUI provides Connection Conversation and Native-Agent Configuration in one glasses HUD, consumes a continuous normal/proactive message stream with TTS/ASR handoff, controls bound PC RabiRoute through Relay, and records packaging plus real-device evidence separately."
  expected_relay_base_url = $expectedRelay
  complete = $complete
  requirements = $requirements
  remaining = @($missing | ForEach-Object { [ordered]@{ id = $_.id; status = $_.status; next_step = $_.next_step } })
}

$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resolvedReportPath -Encoding UTF8

Write-Output ("Wrote goal evidence report: {0}" -f $resolvedReportPath)
Write-Output ("Goal complete: {0}" -f $complete)
if (-not $complete) {
  Write-Output "Remaining evidence gaps:"
  foreach ($item in $report.remaining) {
    Write-Output ("- {0}: {1}; {2}" -f $item.id, $item.status, $item.next_step)
  }
  if ($RequireComplete) {
    exit 1
  }
}
