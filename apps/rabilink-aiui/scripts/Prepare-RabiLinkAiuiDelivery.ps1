param(
  [string] $DeliveryDir = "",
  [string] $AsciiMirrorDir = "",
  [string] $RelayBaseUrl = "",
  [switch] $SkipAsciiMirror,
  [switch] $OpenExplorer
)

$ErrorActionPreference = "Stop"

function Resolve-OptionalPath {
  param([string] $PathValue)
  if (-not $PathValue) { return "" }
  return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($PathValue)
}

function Assert-SafeReplaceRoot {
  param(
    [string] $PathValue,
    [string[]] $AllowedRoots
  )

  $fullPath = [System.IO.Path]::GetFullPath($PathValue)
  foreach ($root in $AllowedRoots) {
    $fullRoot = [System.IO.Path]::GetFullPath($root).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    if ($fullPath.StartsWith($fullRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
      return
    }
  }

  throw "Refusing to replace output directory outside allowed roots: $fullPath"
}

function Reset-Directory {
  param(
    [string] $PathValue,
    [string[]] $AllowedRoots
  )

  Assert-SafeReplaceRoot -PathValue $PathValue -AllowedRoots $AllowedRoots
  if (Test-Path -LiteralPath $PathValue) {
    Remove-Item -LiteralPath $PathValue -Recurse -Force
  }
  New-Item -ItemType Directory -Path $PathValue | Out-Null
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

function Read-AixVersion {
  param([string] $PathValue)

  Add-Type -AssemblyName System.IO.Compression
  $stream = [System.IO.File]::OpenRead($PathValue)
  try {
    $archive = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Read)
    try {
      $entry = $archive.GetEntry("VERSION")
      if ($null -eq $entry) { throw "AIX package is missing VERSION: $PathValue" }
      $reader = [System.IO.StreamReader]::new($entry.Open())
      try { return $reader.ReadToEnd().Trim() }
      finally { $reader.Dispose() }
    }
    finally { $archive.Dispose() }
  }
  finally { $stream.Dispose() }
}

function Copy-DirectoryContents {
  param(
    [string] $SourceRoot,
    [string] $TargetRoot
  )

  New-Item -ItemType Directory -Path $TargetRoot -Force | Out-Null
  Get-ChildItem -LiteralPath $SourceRoot -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $TargetRoot -Recurse -Force
  }
}

function Read-DefaultRelayBaseUrl {
  param([string] $ProjectRoot)

  $defaultsPath = Join-Path $ProjectRoot "utils\rabilink-defaults.js"
  if (Test-Path -LiteralPath $defaultsPath) {
    $defaultsText = Get-Content -LiteralPath $defaultsPath -Raw
    $match = [regex]::Match($defaultsText, 'relayBaseUrl:\s*"([^"]*)"')
    if ($match.Success -and $match.Groups[1].Value.Trim()) {
      return $match.Groups[1].Value.Trim().TrimEnd("/")
    }
  }

  $appJsonPath = Join-Path $ProjectRoot "app.json"
  if (Test-Path -LiteralPath $appJsonPath) {
    $appJson = Get-Content -LiteralPath $appJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($appJson.rabiLink -and [string]$appJson.rabiLink.relayBaseUrl) {
      return ([string]$appJson.rabiLink.relayBaseUrl).Trim().TrimEnd("/")
    }
  }

  return ""
}

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$distRoot = Join-Path $projectRoot "dist"
$tempRoot = [System.IO.Path]::GetTempPath()

if (-not $RelayBaseUrl -and $env:RABILINK_AIUI_RELAY_URL) {
  $RelayBaseUrl = $env:RABILINK_AIUI_RELAY_URL
}
if (-not $RelayBaseUrl) {
  $RelayBaseUrl = Read-DefaultRelayBaseUrl -ProjectRoot $projectRoot
}

if (-not $DeliveryDir) {
  $DeliveryDir = Join-Path $distRoot "delivery"
}
if (-not $AsciiMirrorDir) {
  $AsciiMirrorDir = Join-Path $tempRoot "RabiLink-AIUI-Delivery"
}

$resolvedDeliveryDir = Resolve-OptionalPath $DeliveryDir
$resolvedAsciiMirrorDir = Resolve-OptionalPath $AsciiMirrorDir
$resolvedDistRoot = Resolve-Path -LiteralPath $distRoot
$allowedDeliveryRoots = @([string]$resolvedDistRoot)
$allowedMirrorRoots = @($tempRoot)
$packageVersionId = [System.Guid]::NewGuid().ToString().ToLowerInvariant()

$packageArgs = @(
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  (Join-Path $PSScriptRoot "Package-RabiLinkAiui.ps1"),
  "-VersionId",
  $packageVersionId
)
if ($RelayBaseUrl) {
  $packageArgs += @("-RelayBaseUrl", $RelayBaseUrl)
}
& powershell @packageArgs
if ($LASTEXITCODE -ne 0) {
  throw "Package-RabiLinkAiui.ps1 failed."
}

$craftArgs = @(
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  (Join-Path $PSScriptRoot "Prepare-RabiLinkAiuiCraftUpload.ps1"),
  "-VersionId",
  $packageVersionId
)
if ($RelayBaseUrl) {
  $craftArgs += @("-RelayBaseUrl", $RelayBaseUrl)
}
& powershell @craftArgs
if ($LASTEXITCODE -ne 0) {
  throw "Prepare-RabiLinkAiuiCraftUpload.ps1 failed."
}

$aixPath = Join-Path $distRoot "rabilink-aiui.aix"
$craftUploadPath = Join-Path $distRoot "craft-upload"
if (-not (Test-Path -LiteralPath $aixPath)) {
  throw "Missing AIX package: $aixPath"
}
if (-not (Test-Path -LiteralPath $craftUploadPath)) {
  throw "Missing Craft upload folder: $craftUploadPath"
}
$aixVersion = Read-AixVersion -PathValue $aixPath
$craftUploadVersion = (Get-Content -LiteralPath (Join-Path $craftUploadPath "VERSION") -Raw -Encoding UTF8).Trim()
if ($aixVersion -ne $packageVersionId -or $craftUploadVersion -ne $packageVersionId) {
  throw "Delivery VERSION mismatch: expected=$packageVersionId aix=$aixVersion craft-upload=$craftUploadVersion"
}

Reset-Directory -PathValue $resolvedDeliveryDir -AllowedRoots $allowedDeliveryRoots
Copy-Item -LiteralPath $aixPath -Destination (Join-Path $resolvedDeliveryDir "rabilink-aiui.aix") -Force
Copy-Item -LiteralPath (Join-Path $projectRoot "craft-release.json") -Destination (Join-Path $resolvedDeliveryDir "craft-release.json") -Force
Copy-DirectoryContents -SourceRoot $craftUploadPath -TargetRoot (Join-Path $resolvedDeliveryDir "craft-upload")

$deliveryScriptsDir = Join-Path $resolvedDeliveryDir "scripts"
New-Item -ItemType Directory -Path $deliveryScriptsDir -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "Invoke-RabiLinkAiuiCraftUpload.ps1") -Destination (Join-Path $deliveryScriptsDir "Invoke-RabiLinkAiuiCraftUpload.ps1") -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "RabiLinkAiuiCraftMetadata.ps1") -Destination (Join-Path $deliveryScriptsDir "RabiLinkAiuiCraftMetadata.ps1") -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "Test-RabiLinkAiuiCraftStatus.ps1") -Destination (Join-Path $deliveryScriptsDir "Test-RabiLinkAiuiCraftStatus.ps1") -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "Test-RabiLinkAiuiGoalEvidence.ps1") -Destination (Join-Path $deliveryScriptsDir "Test-RabiLinkAiuiGoalEvidence.ps1") -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "Inspect-RokidAiuiApkSurface.ps1") -Destination (Join-Path $deliveryScriptsDir "Inspect-RokidAiuiApkSurface.ps1") -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "craft-browser-upload-helper.js") -Destination (Join-Path $deliveryScriptsDir "craft-browser-upload-helper.js") -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "craft-browser-embedded-aix-upload-helper.template.js") -Destination (Join-Path $deliveryScriptsDir "craft-browser-embedded-aix-upload-helper.template.js") -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "Import-RabiLinkAiuiBrowserCraftReport.ps1") -Destination (Join-Path $deliveryScriptsDir "Import-RabiLinkAiuiBrowserCraftReport.ps1") -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "Open-RabiLinkAiuiCraftUploadHelper.ps1") -Destination (Join-Path $deliveryScriptsDir "Open-RabiLinkAiuiCraftUploadHelper.ps1") -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "Open-RabiLinkAiuiCraftEmbeddedUploadHelper.ps1") -Destination (Join-Path $deliveryScriptsDir "Open-RabiLinkAiuiCraftEmbeddedUploadHelper.ps1") -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "Wait-RabiLinkAiuiBrowserCraftReport.ps1") -Destination (Join-Path $deliveryScriptsDir "Wait-RabiLinkAiuiBrowserCraftReport.ps1") -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "Test-RabiLinkAiuiRuntimeProof.ps1") -Destination (Join-Path $deliveryScriptsDir "Test-RabiLinkAiuiRuntimeProof.ps1") -Force

$deliveryAixPath = Join-Path $resolvedDeliveryDir "rabilink-aiui.aix"
$aixInfo = Get-Item -LiteralPath $deliveryAixPath
$aixHash = Get-Sha256Hex $deliveryAixPath
$uploadHelperPath = Join-Path $deliveryScriptsDir "Invoke-RabiLinkAiuiCraftUpload.ps1"
$craftFiles = Get-ChildItem -LiteralPath (Join-Path $resolvedDeliveryDir "craft-upload") -Recurse -File |
  ForEach-Object {
    [pscustomobject]@{
      path = $_.FullName.Substring((Join-Path $resolvedDeliveryDir "craft-upload").Length + 1).Replace("\", "/")
      size = $_.Length
      sha256 = Get-Sha256Hex $_.FullName
    }
  } |
  Sort-Object path

$adbPath = Join-Path (Resolve-Path -LiteralPath (Join-Path $projectRoot "..\..")) "apps\rabilink-android\out\tools\android-sdk\platform-tools\adb.exe"
$adbDevices = @()
if (Test-Path -LiteralPath $adbPath) {
  $adbDevices = @(& $adbPath devices -l | Where-Object { $_ -match "\sdevice\s" })
}

$manifest = [pscustomobject]@{
  name = "RabiLink AIUI"
  generated_at = (Get-Date).ToUniversalTime().ToString("o")
  relay_base_url = if ($RelayBaseUrl) { $RelayBaseUrl.Trim().TrimEnd("/") } else { "" }
  craft_release = Get-Content -LiteralPath (Join-Path $projectRoot "craft-release.json") -Raw -Encoding UTF8 | ConvertFrom-Json
  aix = [pscustomobject]@{
    file = "rabilink-aiui.aix"
    version = $aixVersion
    size = $aixInfo.Length
    sha256 = $aixHash
  }
  craft_upload = [pscustomobject]@{
    folder = "craft-upload"
    version = $craftUploadVersion
    file_count = @($craftFiles).Count
    files = $craftFiles
  }
  craft_api_upload = [pscustomobject]@{
    helper = "scripts/Invoke-RabiLinkAiuiCraftUpload.ps1"
    metadata_helper = "scripts/RabiLinkAiuiCraftMetadata.ps1"
    browser_helper = "scripts/craft-browser-upload-helper.js"
    embedded_browser_helper_template = "scripts/craft-browser-embedded-aix-upload-helper.template.js"
    browser_helper_launcher = "scripts/Open-RabiLinkAiuiCraftUploadHelper.ps1"
    embedded_browser_helper_launcher = "scripts/Open-RabiLinkAiuiCraftEmbeddedUploadHelper.ps1"
    browser_report_import_helper = "scripts/Import-RabiLinkAiuiBrowserCraftReport.ps1"
    browser_report_watch_helper = "scripts/Wait-RabiLinkAiuiBrowserCraftReport.ps1"
    status_helper = "scripts/Test-RabiLinkAiuiCraftStatus.ps1"
    goal_evidence_helper = "scripts/Test-RabiLinkAiuiGoalEvidence.ps1"
    apk_surface_helper = "scripts/Inspect-RokidAiuiApkSurface.ps1"
    endpoint = "https://js.rokid.com/api/craft/project/upload-agent"
    dry_run_command = "powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Invoke-RabiLinkAiuiCraftUpload.ps1"
    execute_command = "powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Invoke-RabiLinkAiuiCraftUpload.ps1 -Execute"
    status_command = "powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-RabiLinkAiuiCraftStatus.ps1"
    browser_report_import_command = "powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Import-RabiLinkAiuiBrowserCraftReport.ps1"
    browser_report_watch_command = "powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Wait-RabiLinkAiuiBrowserCraftReport.ps1"
    browser_helper_launch_command = "powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Open-RabiLinkAiuiCraftUploadHelper.ps1"
    embedded_browser_helper_launch_command = "powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Open-RabiLinkAiuiCraftEmbeddedUploadHelper.ps1"
    required_env = @("ROKID_CRAFT_ACCOUNT_TOKEN")
    target_env = @("ROKID_CRAFT_URL", "ROKID_CRAFT_AGENT_ID")
  }
  runtime_proof = [pscustomobject]@{
    helper = "scripts/Test-RabiLinkAiuiRuntimeProof.ps1"
    status_file = "dist/runtime-proof-status.json"
    endpoint = "/api/rabilink/mobile/proofs"
    command = "powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-RabiLinkAiuiRuntimeProof.ps1"
    required_env = @("RABILINK_AIUI_RELAY_URL", "RABILINK_AIUI_TOKEN")
    proof_events = @("app-start", "relay-connected", "pc-bound", "webgui-config-loaded", "webgui-config-saved")
  }
  adb_devices = $adbDevices
}
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $resolvedDeliveryDir "install-manifest.json") -Encoding UTF8

$readme = @"
RabiLink AIUI delivery

Files
- AIX package: rabilink-aiui.aix
- Craft release metadata: craft-release.json
- Craft source folder: craft-upload
- Craft API upload helper: scripts\Invoke-RabiLinkAiuiCraftUpload.ps1
- Craft AIX metadata helper: scripts\RabiLinkAiuiCraftMetadata.ps1
- Craft browser upload helper: scripts\craft-browser-upload-helper.js
- Craft embedded AIX upload helper template: scripts\craft-browser-embedded-aix-upload-helper.template.js
- Craft browser helper launcher: scripts\Open-RabiLinkAiuiCraftUploadHelper.ps1
- Craft embedded browser helper launcher: scripts\Open-RabiLinkAiuiCraftEmbeddedUploadHelper.ps1
- Craft browser report import helper: scripts\Import-RabiLinkAiuiBrowserCraftReport.ps1
- Craft browser report watch helper: scripts\Wait-RabiLinkAiuiBrowserCraftReport.ps1
- Craft status helper: scripts\Test-RabiLinkAiuiCraftStatus.ps1
- Goal evidence helper: scripts\Test-RabiLinkAiuiGoalEvidence.ps1
- Runtime proof helper: scripts\Test-RabiLinkAiuiRuntimeProof.ps1
- Rokid AI app APK surface helper: scripts\Inspect-RokidAiuiApkSurface.ps1
- Manifest: install-manifest.json

AIX SHA256
$aixHash

Shared package VERSION
$aixVersion

Recommended install path
1. Open https://js.rokid.com/craft?region=cn&lang=zh-CN in Chrome.
2. Import either:
   - Local .aix: $deliveryAixPath
   - Local folder: $(Join-Path $resolvedDeliveryDir "craft-upload")
3. Use Craft to package/sync to the glasses.
4. Run readiness with -RequireGlass after the glasses are visible to ADB.

Optional phone-side install-surface audit
Run this when the Rokid AI app updates or the phone changes:
   powershell -NoProfile -ExecutionPolicy Bypass -File "$(Join-Path $deliveryScriptsDir "Inspect-RokidAiuiApkSurface.ps1")"
The current evidence shows no public .aix local import handler, so Craft/account sync remains required.

Optional API upload path
1. Set temporary env vars in PowerShell:
   `$env:ROKID_CRAFT_ACCOUNT_TOKEN="..."
   `$env:ROKID_CRAFT_URL="https://js.rokid.com/craft?defaultAgentId=...&region=cn&lang=zh-CN"
   # or: `$env:ROKID_CRAFT_AGENT_ID="..."
   `$env:ROKID_CRAFT_ACCOUNT_ID="..."   # only if needed
2. Dry-run first:
   powershell -NoProfile -ExecutionPolicy Bypass -File "$uploadHelperPath"
   The helper derives metadata.tools from pages/home/index.json inside this exact AIX.
3. Upload only when the dry-run target is correct:
   powershell -NoProfile -ExecutionPolicy Bypass -File "$uploadHelperPath" -Execute
4. Verify the uploaded agent is visible in the Craft account:
   powershell -NoProfile -ExecutionPolicy Bypass -File "$(Join-Path $deliveryScriptsDir "Test-RabiLinkAiuiCraftStatus.ps1")"
5. Clear temporary env vars after upload and verification.

Optional browser same-origin upload path
Use this when Chrome is already logged in to Craft but you do not want to expose ROKID_CRAFT_ACCOUNT_TOKEN to PowerShell or Codex.
1. Optional launcher, from the project or delivery folder:
   powershell -NoProfile -ExecutionPolicy Bypass -File "$(Join-Path $deliveryScriptsDir "Open-RabiLinkAiuiCraftUploadHelper.ps1")"
   This opens Craft and copies the helper script to the clipboard.
2. Open the target Craft page, for example:
   https://js.rokid.com/craft?defaultAgentId=...&region=cn&lang=zh-CN
3. Open DevTools Console on that Craft page.
4. Paste the clipboard helper, or copy all text from:
   $(Join-Path $deliveryScriptsDir "craft-browser-upload-helper.js")
5. Paste it into the console and press Enter.
6. In the small RabiLink AIUI panel, select:
   $deliveryAixPath
7. Click "Check session", then "Upload selected AIX", then "List agents".
8. Click "Download report" to save rabilink-aiui-craft-upload-report.json.
9. Import the downloaded report into this project evidence:
   powershell -NoProfile -ExecutionPolicy Bypass -File "$(Join-Path $deliveryScriptsDir "Import-RabiLinkAiuiBrowserCraftReport.ps1")"
   Or leave a watcher running before clicking "Download report":
   powershell -NoProfile -ExecutionPolicy Bypass -File "$(Join-Path $deliveryScriptsDir "Wait-RabiLinkAiuiBrowserCraftReport.ps1")"
The helper runs only in the js.rokid.com page context. It reads the same-origin Craft session but never prints the account token. The downloaded report contains status and visible-agent evidence, not the token.

Optional browser embedded-AIX upload path
Use this when Chrome blocks local file selection with "Not allowed".
1. From the project or delivery folder, copy an embedded helper to the clipboard:
   powershell -NoProfile -ExecutionPolicy Bypass -File "$(Join-Path $deliveryScriptsDir "Open-RabiLinkAiuiCraftEmbeddedUploadHelper.ps1")"
2. Open the target Craft page and DevTools Console.
3. Paste the embedded helper and press Enter.
4. If the agentId field is empty, click "Find agentId"; the launcher also tries ROKID_CRAFT_AGENT_ID, ROKID_CRAFT_URL, and the last craft-upload-status.json target.
5. Click "Check session", "Upload embedded AIX", "List agents", and "Download report".
This embeds the current AIX package bytes into the pasted helper, so Chrome does not need file URL access. The helper still runs only on js.rokid.com and never prints the account token.

If Codex Chrome upload fails with "Not allowed" or a file chooser timeout:
1. Open chrome://extensions
2. Open the Codex extension details
3. Enable Allow access to file URLs
4. Retry importing the local .aix

The AIX package does not embed a Relay token. Bind the pages/home/index tool token parameter to the agent memory variable rabilinkToken; the platform injects it only when invoking the UI. The agent fills mode as transcription or configuration. Do not import the separate RabiLinkMessage submit/poll tools for this AIX flow.

PC prerequisite
The global "Connect server" switch only registers the PC. Enable a RabiLink Route with rabilink input/output, Codex, the RabiActive persona, an explicit Agent working directory, and a fixed thread. The sanitized templates live in examples/data/route/RabiLink and examples/data/roles/RabiActive; they are disabled by default and contain no Relay credentials.

Runtime proof after glasses launch
1. In the RabiLink agent, bind pages/home/index token to rabilinkToken and publish the agent.
2. Ask the agent to open recording transcription with mode=transcription, or open the conversational configuration assistant with mode=configuration and a complete intent. In the assistant, verify that replies arrive, then swipe forward to return to transcription.
3. Query the Relay proof log from this project:
   `$env:RABILINK_AIUI_RELAY_URL="https://your-relay.example.com"
   `$env:RABILINK_AIUI_TOKEN="..."
   powershell -NoProfile -ExecutionPolicy Bypass -File "$(Join-Path $deliveryScriptsDir "Test-RabiLinkAiuiRuntimeProof.ps1")"
   Remove-Item Env:RABILINK_AIUI_TOKEN
   Remove-Item Env:RABILINK_AIUI_RELAY_URL -ErrorAction SilentlyContinue
4. The helper writes dist\runtime-proof-status.json. Goal evidence treats that report as the glasses runtime test proof.
"@
$readme | Set-Content -LiteralPath (Join-Path $resolvedDeliveryDir "README-install.txt") -Encoding UTF8

if (-not $SkipAsciiMirror) {
  Reset-Directory -PathValue $resolvedAsciiMirrorDir -AllowedRoots $allowedMirrorRoots
  Copy-DirectoryContents -SourceRoot $resolvedDeliveryDir -TargetRoot $resolvedAsciiMirrorDir
  if ($OpenExplorer) {
    Start-Process -FilePath "explorer.exe" -ArgumentList @($resolvedAsciiMirrorDir)
  }
}

Write-Output ("Prepared delivery folder: {0}" -f $resolvedDeliveryDir)
Write-Output ("AIX size: {0}" -f $aixInfo.Length)
Write-Output ("AIX sha256: {0}" -f $aixHash)
Write-Output ("Shared VERSION: {0}" -f $aixVersion)
Write-Output ("Craft files: {0}" -f @($craftFiles).Count)
if (-not $SkipAsciiMirror) {
  Write-Output ("ASCII mirror: {0}" -f $resolvedAsciiMirrorDir)
}
