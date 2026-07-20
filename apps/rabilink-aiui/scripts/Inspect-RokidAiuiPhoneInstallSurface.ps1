param(
  [string] $AdbPath = "",
  [string] $AaptPath = "",
  [string] $DeviceAixPath = "/sdcard/Download/rabilink-aiui.aix",
  [string] $ReportPath = "",
  [switch] $PullApk,
  [switch] $OpenAgentManage,
  [switch] $ProbeAgentActivities,
  [switch] $CaptureCurrentUi,
  [switch] $TraceAgentStoreUi
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

function Get-PackagePath {
  param(
    [string] $Adb,
    [string] $PackageName
  )
  $line = & $Adb shell pm path $PackageName 2>$null | Select-Object -First 1
  if (-not $line) { return "" }
  return ($line -replace "^package:", "").Trim()
}

function Find-Lines {
  param(
    [string[]] $Lines,
    [string] $Pattern,
    [int] $Limit = 80
  )
  return @($Lines | Where-Object { $_ -match $Pattern } | Select-Object -First $Limit)
}

function Invoke-AdbText {
  param(
    [string] $Adb,
    [string[]] $Arguments
  )
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = @(& $Adb @Arguments 2>&1 | ForEach-Object { $_.ToString() })
    return $output -join "`n"
  }
  finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
}

function Get-DeviceSize {
  param([string] $Adb)

  $wmSizeOutput = Invoke-AdbText -Adb $Adb -Arguments @("shell", "wm", "size")
  $match = [regex]::Match($wmSizeOutput, "(\d+)x(\d+)")
  if ($match.Success) {
    return [pscustomobject]@{
      Width = [int]$match.Groups[1].Value
      Height = [int]$match.Groups[2].Value
      Raw = $wmSizeOutput
    }
  }

  return [pscustomobject]@{
    Width = 1440
    Height = 3200
    Raw = $wmSizeOutput
  }
}

function Invoke-AdbTapRatio {
  param(
    [string] $Adb,
    [pscustomobject] $DeviceSize,
    [double] $XRatio,
    [double] $YRatio
  )

  $x = [int][Math]::Round($DeviceSize.Width * $XRatio)
  $y = [int][Math]::Round($DeviceSize.Height * $YRatio)
  return Invoke-AdbText -Adb $Adb -Arguments @("shell", "input", "tap", [string]$x, [string]$y)
}

function Get-TopActivityLines {
  param([string] $Adb)

  $topOutput = Invoke-AdbText -Adb $Adb -Arguments @("shell", "dumpsys", "activity", "activities")
  return @($topOutput -split "`n" | Where-Object { $_ -match "mResumedActivity|topResumedActivity" } | Select-Object -First 5)
}

function Save-PhoneScreenTraceStep {
  param(
    [string] $Adb,
    [string] $ReportDir,
    [string] $Name
  )

  $screenDevicePath = "/sdcard/rabilink-aiui-$Name.png"
  $uiDevicePath = "/sdcard/rabilink-aiui-$Name.xml"
  $screenLocalPath = Join-Path $ReportDir ("phone-trace-$Name.png")
  $uiLocalPath = Join-Path $ReportDir ("phone-trace-$Name.xml")
  $screenOutput = Invoke-AdbText -Adb $Adb -Arguments @("shell", "screencap", "-p", $screenDevicePath)
  $dumpOutput = Invoke-AdbText -Adb $Adb -Arguments @("shell", "uiautomator", "dump", $uiDevicePath)
  $pullScreenOutput = Invoke-AdbText -Adb $Adb -Arguments @("pull", $screenDevicePath, $screenLocalPath)
  $pullUiOutput = Invoke-AdbText -Adb $Adb -Arguments @("pull", $uiDevicePath, $uiLocalPath)
  $topLines = Get-TopActivityLines -Adb $Adb

  return [ordered]@{
    name = $Name
    screenshot = $screenLocalPath
    ui_xml = if (Test-Path -LiteralPath $uiLocalPath) { $uiLocalPath } else { "" }
    screencap_output = $screenOutput
    dump_output = $dumpOutput
    pull_screen_output = $pullScreenOutput
    pull_ui_output = $pullUiOutput
    top_activity_lines = $topLines
  }
}

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$repoRoot = Resolve-Path -LiteralPath (Join-Path $projectRoot "..\..")
if (-not $AdbPath) {
  $AdbPath = Join-Path $repoRoot "apps\rabilink-android\out\tools\android-sdk\platform-tools\adb.exe"
}
if (-not $AaptPath) {
  $AaptPath = Join-Path $repoRoot "apps\rabilink-android\out\tools\android-sdk\build-tools\34.0.0\aapt.exe"
}
if (-not $ReportPath) {
  $ReportPath = Join-Path $projectRoot "dist\phone-install-surface.json"
}

$resolvedAdbPath = Resolve-OptionalPath $AdbPath
$resolvedAaptPath = Resolve-OptionalPath $AaptPath
$resolvedReportPath = Resolve-OptionalPath $ReportPath
$reportDir = Split-Path -Parent $resolvedReportPath
if (-not (Test-Path -LiteralPath $reportDir)) {
  New-Item -ItemType Directory -Path $reportDir | Out-Null
}

if (-not (Test-Path -LiteralPath $resolvedAdbPath)) {
  throw "ADB executable is missing: $resolvedAdbPath"
}

$adbDevices = @(& $resolvedAdbPath devices -l | Where-Object { $_ -match "\sdevice\s" })
$packages = @(& $resolvedAdbPath shell pm list packages | Where-Object { $_ -match "(?i)rokid|sprite|aiui|glass" })
$targetPackages = @("com.rokid.sprite.aiapp", "com.weiyi.sprite")

$deviceAixListing = & $resolvedAdbPath shell ls -l $DeviceAixPath 2>$null
$deviceAixHashOutput = & $resolvedAdbPath shell sha256sum $DeviceAixPath 2>$null
$deviceAixHash = ""
if ($deviceAixHashOutput) {
  $deviceAixHash = @($deviceAixHashOutput -split "\s+")[0]
}

$packageReports = foreach ($packageName in $targetPackages) {
  $packagePath = Get-PackagePath -Adb $resolvedAdbPath -PackageName $packageName
  $dumpsysText = @()
  if ($packagePath) {
    $dumpsysText = @(& $resolvedAdbPath shell dumpsys package $packageName)
  }
  $supportsAixFileIntent = [bool](($dumpsysText -join "`n") -match "(?i)\\.aix|application/(x-)?zip|application/octet-stream")
  $txtPrompterOnly = [bool](($dumpsysText -join "`n") -match "(?i)PrompterMainActivity" -and ($dumpsysText -join "`n") -match "\\.txt")
  $deepLinks = Find-Lines -Lines $dumpsysText -Pattern "(?i)ecology|rokid://|rokidai|agent|dialogflow|manage|install|upload" -Limit 120

  [ordered]@{
    package = $packageName
    installed = [bool]$packagePath
    apk_path = $packagePath
    supports_aix_file_intent = $supportsAixFileIntent
    txt_prompter_file_handler_only = $txtPrompterOnly
    resolver_lines = $deepLinks
  }
}

$apkReport = $null
if ($PullApk) {
  if (-not (Test-Path -LiteralPath $resolvedAaptPath)) {
    throw "aapt executable is missing: $resolvedAaptPath"
  }

  $inspectRoot = Join-Path ([System.IO.Path]::GetTempPath()) "rokid-aiui-apk-inspect"
  if (-not (Test-Path -LiteralPath $inspectRoot)) {
    New-Item -ItemType Directory -Path $inspectRoot | Out-Null
  }

  $rokidApkPath = ($packageReports | Where-Object { $_.package -eq "com.rokid.sprite.aiapp" }).apk_path
  $localRokidApk = Join-Path $inspectRoot "com.rokid.sprite.aiapp-base.apk"
  if ($rokidApkPath) {
    & $resolvedAdbPath pull $rokidApkPath $localRokidApk | Out-Null
  }

  $manifestOutputPath = Join-Path $inspectRoot "rokid-aiapp-manifest.txt"
  $stringsOutputPath = Join-Path $inspectRoot "rokid-aiapp-strings.txt"
  if (Test-Path -LiteralPath $localRokidApk) {
    & $resolvedAaptPath dump xmltree $localRokidApk AndroidManifest.xml | Set-Content -LiteralPath $manifestOutputPath -Encoding UTF8
    & $resolvedAaptPath dump strings $localRokidApk | Set-Content -LiteralPath $stringsOutputPath -Encoding UTF8
    $manifestLines = Get-Content -LiteralPath $manifestOutputPath
    $stringLines = Get-Content -LiteralPath $stringsOutputPath

    $apkReport = [ordered]@{
      local_apk = $localRokidApk
      local_apk_sha256 = Get-Sha256Hex $localRokidApk
      manifest_dump = $manifestOutputPath
      strings_dump = $stringsOutputPath
      agent_deep_link_paths = Find-Lines -Lines $manifestLines -Pattern 'android:path.*="/(manage|dialogflow|mark|unbind/confirm|config)"' -Limit 40
      install_strings = Find-Lines -Lines $stringLines -Pattern "AIUI|Agent debug|Agent store|Install a new app|Upload files to glasses|APK|60MB|300 MB" -Limit 80
    }
  }
}

$openAgentManageResult = ""
if ($OpenAgentManage) {
  $openAgentManageResult = (& $resolvedAdbPath shell am start -W -a com.rokid.ecology.intent.action.VIEW -d ecology://agent/manage 2>&1) -join "`n"
}

$agentActivityProbe = @()
if ($ProbeAgentActivities) {
  $agentActivities = @(
    "com.rokid.sprite.aiapp/com.rokid.ecology.agentStore.ui.manage.AgentManageActivity",
    "com.rokid.sprite.aiapp/com.rokid.ecology.agentStore.ui.markagent.MarkAgentActivity",
    "com.rokid.sprite.aiapp/com.rokid.ecology.agentStore.DialogFlowActivity"
  )
  foreach ($activity in $agentActivities) {
    $startOutput = Invoke-AdbText -Adb $resolvedAdbPath -Arguments @("shell", "am", "start", "-n", $activity)
    Start-Sleep -Seconds 1
    $topOutput = Invoke-AdbText -Adb $resolvedAdbPath -Arguments @("shell", "dumpsys", "activity", "activities")
    $topLines = @($topOutput -split "`n" | Where-Object { $_ -match "mResumedActivity|topResumedActivity" } | Select-Object -First 5)
    $agentActivityProbe += [ordered]@{
      activity = $activity
      start_output = $startOutput
      start_allowed = $startOutput -notmatch "(?i)SecurityException|Permission Denial|not exported|Error:"
      permission_denied = $startOutput -match "(?i)Permission Denial|not exported"
      top_activity_lines = $topLines
    }
  }
}

$currentUiReport = $null
if ($CaptureCurrentUi) {
  $uiXmlDevicePath = "/sdcard/window-rabilink-aiui.xml"
  $screenDevicePath = "/sdcard/rabilink-aiui-phone-screen.png"
  $uiXmlLocalPath = Join-Path $reportDir "phone-current-ui.xml"
  $screenLocalPath = Join-Path $reportDir "phone-current-screen.png"
  $dumpOutput = Invoke-AdbText -Adb $resolvedAdbPath -Arguments @("shell", "uiautomator", "dump", $uiXmlDevicePath)
  $screenOutput = Invoke-AdbText -Adb $resolvedAdbPath -Arguments @("shell", "screencap", "-p", $screenDevicePath)
  & $resolvedAdbPath pull $uiXmlDevicePath $uiXmlLocalPath | Out-Null
  & $resolvedAdbPath pull $screenDevicePath $screenLocalPath | Out-Null
  $uiText = if (Test-Path -LiteralPath $uiXmlLocalPath) { Get-Content -LiteralPath $uiXmlLocalPath -Raw } else { "" }
  $topOutput = Invoke-AdbText -Adb $resolvedAdbPath -Arguments @("shell", "dumpsys", "activity", "activities")
  $currentUiReport = [ordered]@{
    ui_xml = $uiXmlLocalPath
    screenshot = $screenLocalPath
    dump_output = $dumpOutput
    screencap_output = $screenOutput
    top_activity_lines = @($topOutput -split "`n" | Where-Object { $_ -match "mResumedActivity|topResumedActivity" } | Select-Object -First 5)
    visible_text_hints = Find-Lines -Lines @($uiText -split "`n") -Pattern 'text="[^"]+"' -Limit 40
  }
}

$agentStoreUiTrace = $null
if ($TraceAgentStoreUi) {
  $deviceSize = Get-DeviceSize -Adb $resolvedAdbPath
  $traceSteps = New-Object System.Collections.Generic.List[object]

  Invoke-AdbText -Adb $resolvedAdbPath -Arguments @("shell", "am", "start", "-n", "com.rokid.sprite.aiapp/com.rokid.sprite.aiapp.ui.MainActivity") | Out-Null
  Start-Sleep -Milliseconds 1200
  Invoke-AdbTapRatio -Adb $resolvedAdbPath -DeviceSize $deviceSize -XRatio 0.315 -YRatio 0.961 | Out-Null
  Start-Sleep -Milliseconds 1200
  $traceSteps.Add((Save-PhoneScreenTraceStep -Adb $resolvedAdbPath -ReportDir $reportDir -Name "home-tab"))

  Invoke-AdbTapRatio -Adb $resolvedAdbPath -DeviceSize $deviceSize -XRatio 0.272 -YRatio 0.492 | Out-Null
  Start-Sleep -Milliseconds 1800
  $traceSteps.Add((Save-PhoneScreenTraceStep -Adb $resolvedAdbPath -ReportDir $reportDir -Name "agent-store"))

  Invoke-AdbTapRatio -Adb $resolvedAdbPath -DeviceSize $deviceSize -XRatio 0.920 -YRatio 0.075 | Out-Null
  Start-Sleep -Milliseconds 1400
  $traceSteps.Add((Save-PhoneScreenTraceStep -Adb $resolvedAdbPath -ReportDir $reportDir -Name "agent-manage"))

  Invoke-AdbText -Adb $resolvedAdbPath -Arguments @("shell", "input", "keyevent", "KEYCODE_BACK") | Out-Null
  Start-Sleep -Milliseconds 800
  Invoke-AdbTapRatio -Adb $resolvedAdbPath -DeviceSize $deviceSize -XRatio 0.826 -YRatio 0.075 | Out-Null
  Start-Sleep -Milliseconds 900
  Invoke-AdbText -Adb $resolvedAdbPath -Arguments @("shell", "input", "text", "RabiLink") | Out-Null
  Start-Sleep -Milliseconds 500
  Invoke-AdbTapRatio -Adb $resolvedAdbPath -DeviceSize $deviceSize -XRatio 0.875 -YRatio 0.075 | Out-Null
  Start-Sleep -Milliseconds 1800
  $traceSteps.Add((Save-PhoneScreenTraceStep -Adb $resolvedAdbPath -ReportDir $reportDir -Name "agent-search-rabilink"))

  $agentStoreReachable = @($traceSteps | Where-Object { (($_.top_activity_lines -join "`n") -match "AgentStoreActivity") }).Count -gt 0
  $agentManageReachable = @($traceSteps | Where-Object { (($_.top_activity_lines -join "`n") -match "AgentManageActivity") }).Count -gt 0
  $agentSearchReachable = @($traceSteps | Where-Object { (($_.top_activity_lines -join "`n") -match "AgentSearchActivity") }).Count -gt 0

  $agentStoreUiTrace = [ordered]@{
    device_size = @{
      width = $deviceSize.Width
      height = $deviceSize.Height
      raw = $deviceSize.Raw
    }
    steps = $traceSteps.ToArray()
    agent_store_public_path_reachable = $agentStoreReachable
    agent_manage_public_path_reachable = $agentManageReachable
    agent_search_public_path_reachable = $agentSearchReachable
    searched_keyword = "RabiLink"
    interpretation = "Public UI path reaches the agent store, agent management, and search pages. The saved search screenshot is the evidence for whether the app is visible in the store account."
  }
}

$publicAixFileHandlerDetected = @($packageReports | Where-Object { $_.supports_aix_file_intent }).Count -gt 0
$agentManageDeepLinkResolvable = $false
if ($openAgentManageResult) {
  $agentManageDeepLinkResolvable = $openAgentManageResult -notmatch "(?i)unable to resolve|Error:"
}

$report = [ordered]@{
  generated_at = (Get-Date).ToUniversalTime().ToString("o")
  adb = $resolvedAdbPath
  aapt = if (Test-Path -LiteralPath $resolvedAaptPath) { $resolvedAaptPath } else { "" }
  adb_devices = $adbDevices
  matching_packages = $packages
  device_aix = @{
    path = $DeviceAixPath
    listing = $deviceAixListing
    sha256 = $deviceAixHash
  }
  packages = $packageReports
  apk_inspection = $apkReport
  open_agent_manage_result = $openAgentManageResult
  agent_activity_probe = $agentActivityProbe
  current_ui = $currentUiReport
  agent_store_ui_trace = $agentStoreUiTrace
  conclusion = @{
    public_aix_file_handler_detected = $publicAixFileHandlerDetected
    agent_manage_deep_link_resolvable = $agentManageDeepLinkResolvable
    agent_manage_activity_adb_start_allowed = [bool](@($agentActivityProbe | Where-Object { $_.activity -match "AgentManageActivity" -and $_.start_allowed }).Count -gt 0)
    agent_manage_activity_not_exported = [bool](@($agentActivityProbe | Where-Object { $_.activity -match "AgentManageActivity" -and $_.permission_denied }).Count -gt 0)
    agent_store_public_path_reachable = [bool]($agentStoreUiTrace -and $agentStoreUiTrace.agent_store_public_path_reachable)
    agent_manage_public_path_reachable = [bool]($agentStoreUiTrace -and $agentStoreUiTrace.agent_manage_public_path_reachable)
    agent_search_public_path_reachable = [bool]($agentStoreUiTrace -and $agentStoreUiTrace.agent_search_public_path_reachable)
    likely_manual_path = "Rokid AI app -> glasses app management / AIUI debug / agent store"
    safe_next_step = "Use Craft or the Rokid AI app UI to install/sync; no public .aix file intent or externally startable agent manage activity was detected."
  }
}

$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resolvedReportPath -Encoding UTF8

Write-Output ("Wrote phone install surface report: {0}" -f $resolvedReportPath)
Write-Output ("ADB devices: {0}" -f $adbDevices.Count)
Write-Output ("Rokid packages: {0}" -f ($packages -join ", "))
Write-Output ("Device AIX sha256: {0}" -f $deviceAixHash)
Write-Output ("Public .aix file handler detected: {0}" -f $report.conclusion.public_aix_file_handler_detected)
if ($OpenAgentManage) {
  Write-Output ("Agent manage deep link resolvable: {0}" -f $report.conclusion.agent_manage_deep_link_resolvable)
  if ($openAgentManageResult) {
    Write-Output $openAgentManageResult
  }
}
if ($ProbeAgentActivities) {
  foreach ($probe in $agentActivityProbe) {
    Write-Output ("Probe {0}: start_allowed={1} permission_denied={2}" -f $probe.activity, $probe.start_allowed, $probe.permission_denied)
  }
}
if ($CaptureCurrentUi -and $currentUiReport) {
  Write-Output ("Current UI XML: {0}" -f $currentUiReport.ui_xml)
  Write-Output ("Current screenshot: {0}" -f $currentUiReport.screenshot)
}
if ($TraceAgentStoreUi -and $agentStoreUiTrace) {
  Write-Output ("Agent store public path reachable: {0}" -f $agentStoreUiTrace.agent_store_public_path_reachable)
  Write-Output ("Agent manage public path reachable: {0}" -f $agentStoreUiTrace.agent_manage_public_path_reachable)
  Write-Output ("Agent search public path reachable: {0}" -f $agentStoreUiTrace.agent_search_public_path_reachable)
  foreach ($step in $agentStoreUiTrace.steps) {
    Write-Output ("Trace {0}: {1}" -f $step.name, $step.screenshot)
  }
}
if ($apkReport) {
  Write-Output ("APK strings include install/debug hints: {0}" -f @($apkReport.install_strings).Count)
}
