param(
  [string]$ManagerUrl = "http://127.0.0.1:8790",
  [string]$DefaultRouteName = "default-main",
  [int]$IntervalSeconds = 1800,
  [int]$ManagerStartTimeoutSeconds = 30,
  [int]$ManagerRecoveryBaseDelaySeconds = 15,
  [int]$ManagerRecoveryMaxDelaySeconds = 300,
  [int]$ManagerProbeAttempts = 3,
  [int]$ManagerProbeRetryDelayMilliseconds = 500,
  [switch]$Once,
  [switch]$NoRepair,
  [switch]$IncludeDisabled,
  [switch]$NoTrayRepair
)

$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$localBypassHosts = @("127.0.0.1", "localhost", "::1")
$existingNoProxy = @(([string]$env:NO_PROXY -split ",") + ([string]$env:no_proxy -split ",")) |
  ForEach-Object { $_.Trim() } |
  Where-Object { $_ }
$env:NO_PROXY = (@($existingNoProxy + $localBypassHosts) | Select-Object -Unique) -join ","
$env:no_proxy = $env:NO_PROXY
[System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy
$LogsDir = Join-Path $ProjectRoot "data\route\$DefaultRouteName\logs"
New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null

$TextLogPath = Join-Path $LogsDir "rabiroute-health-watch.log"
$JsonlLogPath = Join-Path $LogsDir "rabiroute-health-watch.jsonl"
$LatestSummaryPath = Join-Path $LogsDir "rabiroute-health-latest.md"

function Write-HealthLog {
  param([string]$Message)
  $line = "[$(Get-Date -Format o)] $Message"
  Write-Host $line
  Add-Content -LiteralPath $TextLogPath -Encoding UTF8 -Value $line
}

function Add-Issue {
  param(
    [System.Collections.Generic.List[object]]$Issues,
    [string]$Scope,
    [string]$Severity,
    [string]$Message,
    [string]$Action = "",
    [bool]$Repaired = $false,
    [bool]$NeedsUser = $false,
    [ValidateSet("system", "adapter")]
    [string]$Impact = "system",
    [string]$Adapter = ""
  )
  $Issues.Add([pscustomobject]@{
    scope = $Scope
    severity = $Severity
    impact = $Impact
    adapter = $Adapter
    message = $Message
    action = $Action
    repaired = $Repaired
    needsUser = $NeedsUser
  }) | Out-Null
}

function Get-Prop {
  param([object]$Object, [string]$Name)
  if ($null -eq $Object) { return $null }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function Invoke-Json {
  param(
    [string]$Path,
    [string]$Method = "Get",
    [object]$Body = $null,
    [int]$TimeoutSec = 8,
    [switch]$AllowHttpError
  )

  $arguments = @{
    Uri = "$ManagerUrl$Path"
    Method = $Method
    TimeoutSec = $TimeoutSec
  }
  if ($null -ne $Body) {
    $arguments.ContentType = "application/json; charset=utf-8"
    $arguments.Body = ($Body | ConvertTo-Json -Depth 12 -Compress)
  }

  if ($AllowHttpError) {
    try {
      $response = Invoke-WebRequest @arguments
      $content = [string]$response.Content
      $json = if ($content.Trim()) { $content | ConvertFrom-Json } else { [pscustomobject]@{} }
      return [pscustomobject]@{
        statusCode = [int]$response.StatusCode
        body = $json
      }
    } catch {
      $statusCode = 0
      $content = ""
      if ($_.Exception.Response) {
        try {
          $statusCode = [int]$_.Exception.Response.StatusCode
          $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
          $content = $reader.ReadToEnd()
        } catch {
          $content = ""
        }
      }
      $json = if ($content.Trim()) {
        try { $content | ConvertFrom-Json } catch { [pscustomobject]@{ message = $content } }
      } else {
        [pscustomobject]@{ message = $_.Exception.Message }
      }
      return [pscustomobject]@{
        statusCode = $statusCode
        body = $json
      }
    }
  }

  return Invoke-RestMethod @arguments
}

function Test-Manager {
  try {
    return Invoke-Json -Path "/meta" -TimeoutSec 4
  } catch {
    return $null
  }
}

function Test-ManagerListener {
  try {
    $uri = [uri]$ManagerUrl
    if ($uri.Host -notin @("127.0.0.1", "localhost", "::1")) { return $null }
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
      $pending = $client.BeginConnect($uri.Host, $uri.Port, $null, $null)
      if (-not $pending.AsyncWaitHandle.WaitOne(500)) { return $false }
      $client.EndConnect($pending)
      return $true
    } finally {
      $client.Dispose()
    }
  } catch {
    return $false
  }
}

function Test-ManagerWithRetry {
  $attemptLimit = [Math]::Max(1, $ManagerProbeAttempts)
  $attempt = 0
  $meta = $null
  while ($attempt -lt $attemptLimit) {
    $attempt += 1
    $meta = Test-Manager
    if ($meta) { break }
    if ($attempt -lt $attemptLimit) {
      Start-Sleep -Milliseconds ([Math]::Max(0, $ManagerProbeRetryDelayMilliseconds))
    }
  }
  $listener = if ($meta) { $true } else { Test-ManagerListener }
  return [pscustomobject]@{
    meta = $meta
    attempts = $attempt
    transientFailure = [bool]($meta -and $attempt -gt 1)
    listenerPresent = $listener
    classification = if ($meta) {
      if ($attempt -gt 1) { "transient_control_plane_failure" } else { "healthy" }
    } elseif ($listener -eq $true) {
      "control_plane_unresponsive"
    } else {
      "process_or_listener_absent"
    }
  }
}

function Get-ManagerRecoveryState {
  $files = @(Get-ChildItem -LiteralPath $LogsDir -Filter "manager-recovery-*.jsonl" -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 2)
  foreach ($file in $files) {
    $lines = @(Get-Content -LiteralPath $file.FullName -Tail 200 -ErrorAction SilentlyContinue)
    for ($index = $lines.Count - 1; $index -ge 0; $index--) {
      try {
        $record = $lines[$index] | ConvertFrom-Json
        if ($null -ne $record.consecutiveFailures) {
          return [pscustomobject]@{
            consecutiveFailures = [int]$record.consecutiveFailures
            nextAttemptAt = [string]$record.nextAttemptAt
          }
        }
      } catch {
      }
    }
  }
  return [pscustomobject]@{
    consecutiveFailures = 0
    nextAttemptAt = ""
  }
}

function Write-ManagerRecoveryEvent {
  param(
    [string]$Event,
    [int]$ConsecutiveFailures,
    [string]$NextAttemptAt = "",
    [Nullable[int]]$LauncherPid = $null,
    [Nullable[int]]$LauncherExitCode = $null,
    [string]$StdoutLog = "",
    [string]$StderrLog = "",
    [string]$Message = ""
  )
  $record = [ordered]@{
    schemaVersion = 1
    eventId = [guid]::NewGuid().ToString()
    time = (Get-Date).ToString("o")
    event = $Event
    consecutiveFailures = $ConsecutiveFailures
    nextAttemptAt = if ($NextAttemptAt) { $NextAttemptAt } else { $null }
    launcherPid = $LauncherPid
    launcherExitCode = $LauncherExitCode
    stdoutLog = if ($StdoutLog) { Split-Path -Leaf $StdoutLog } else { $null }
    stderrLog = if ($StderrLog) { Split-Path -Leaf $StderrLog } else { $null }
    message = if ($Message) { $Message } else { $null }
  }
  $recoveryLog = Join-Path $LogsDir ("manager-recovery-{0}.jsonl" -f (Get-Date -Format "yyyy-MM-dd"))
  Add-Content -LiteralPath $recoveryLog -Encoding UTF8 -Value ($record | ConvertTo-Json -Compress)
}

function Reset-ManagerRecoveryBackoff {
  $state = Get-ManagerRecoveryState
  if ($state.consecutiveFailures -gt 0 -or $state.nextAttemptAt) {
    Write-ManagerRecoveryEvent -Event "manager_healthy" -ConsecutiveFailures 0
  }
}

function Start-ManagerIfNeeded {
  param([System.Collections.Generic.List[object]]$Issues)
  if ($NoRepair) { return }
  $managerJs = Join-Path $ProjectRoot "dist\manager.js"
  $launcher = Join-Path $ProjectRoot "Start-RabiRoute-Tray.bat"
  if (-not (Test-Path $managerJs)) {
    Add-Issue $Issues "manager" "error" "Manager is unreachable and dist\manager.js is missing." "Cannot auto-start before build." $false $true
    return
  }
  if (-not (Test-Path $launcher)) {
    Add-Issue $Issues "manager" "error" "Manager is unreachable and the Windows launcher is missing." "Cannot perform a guarded recovery." $false $true
    return
  }
  $state = Get-ManagerRecoveryState
  if ($state.nextAttemptAt) {
    try {
      $nextAttempt = [datetimeoffset]::Parse($state.nextAttemptAt)
      if ($nextAttempt -gt [datetimeoffset]::Now) {
        $remaining = [Math]::Max(1, [Math]::Ceiling(($nextAttempt - [datetimeoffset]::Now).TotalSeconds))
        Write-ManagerRecoveryEvent `
          -Event "recovery_backoff_skipped" `
          -ConsecutiveFailures $state.consecutiveFailures `
          -NextAttemptAt $state.nextAttemptAt `
          -Message "Recovery is deferred for ${remaining}s."
        Add-Issue $Issues "manager" "warning" "Manager recovery is in backoff for ${remaining}s." "The next scheduled health cycle will retry." $false $false
        return
      }
    } catch {
    }
  }

  $stamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
  $managerOutLog = Join-Path $LogsDir "manager-recovery-$stamp.stdout.log"
  $managerErrLog = Join-Path $LogsDir "manager-recovery-$stamp.stderr.log"
  try {
    $recovery = Start-Process `
      -FilePath $launcher `
      -ArgumentList @("-NoTray", "-NoOpen", "-NoBuild", "-UseExistingBuild", "-ReuseHealthyManager") `
      -WorkingDirectory $ProjectRoot `
      -RedirectStandardOutput $managerOutLog `
      -RedirectStandardError $managerErrLog `
      -WindowStyle Hidden `
      -PassThru
    Write-ManagerRecoveryEvent `
      -Event "recovery_started" `
      -ConsecutiveFailures $state.consecutiveFailures `
      -LauncherPid $recovery.Id `
      -StdoutLog $managerOutLog `
      -StderrLog $managerErrLog
    $deadline = (Get-Date).AddSeconds([Math]::Max(5, $ManagerStartTimeoutSeconds))
    do {
      if (Test-Manager) {
        $exitCode = if ($recovery.HasExited) { [Nullable[int]]$recovery.ExitCode } else { $null }
        Write-ManagerRecoveryEvent `
          -Event "recovery_succeeded" `
          -ConsecutiveFailures 0 `
          -LauncherPid $recovery.Id `
          -LauncherExitCode $exitCode `
          -StdoutLog $managerOutLog `
          -StderrLog $managerErrLog
        Add-Issue $Issues "manager" "error" "Manager was unreachable." "Recovered through the guarded Windows launcher (pid=$($recovery.Id))." $true $false
        return
      }
      if ($recovery.HasExited -and $recovery.ExitCode -ne 0) {
        break
      }
      Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)

    $failureCount = $state.consecutiveFailures + 1
    $delaySeconds = [Math]::Min(
      [Math]::Max(1, $ManagerRecoveryMaxDelaySeconds),
      [Math]::Max(1, $ManagerRecoveryBaseDelaySeconds) * [Math]::Pow(2, [Math]::Min(10, $failureCount - 1))
    )
    $nextAttemptAt = [datetimeoffset]::Now.AddSeconds($delaySeconds).ToString("o")
    $exitCode = if ($recovery.HasExited) { [Nullable[int]]$recovery.ExitCode } else { $null }
    Write-ManagerRecoveryEvent `
      -Event "recovery_failed" `
      -ConsecutiveFailures $failureCount `
      -NextAttemptAt $nextAttemptAt `
      -LauncherPid $recovery.Id `
      -LauncherExitCode $exitCode `
      -StdoutLog $managerOutLog `
      -StderrLog $managerErrLog `
      -Message "Manager did not become healthy within the guarded recovery window."
    Add-Issue $Issues "manager" "error" "Manager stayed unreachable after guarded recovery." "Retry backoff=${delaySeconds}s. Check $([IO.Path]::GetFileName($managerOutLog)), $([IO.Path]::GetFileName($managerErrLog)), and the newest launcher log." $false $true
  } catch {
    $failureCount = $state.consecutiveFailures + 1
    $delaySeconds = [Math]::Min(
      [Math]::Max(1, $ManagerRecoveryMaxDelaySeconds),
      [Math]::Max(1, $ManagerRecoveryBaseDelaySeconds) * [Math]::Pow(2, [Math]::Min(10, $failureCount - 1))
    )
    $nextAttemptAt = [datetimeoffset]::Now.AddSeconds($delaySeconds).ToString("o")
    Write-ManagerRecoveryEvent `
      -Event "recovery_failed" `
      -ConsecutiveFailures $failureCount `
      -NextAttemptAt $nextAttemptAt `
      -StdoutLog $managerOutLog `
      -StderrLog $managerErrLog `
      -Message $_.Exception.Message
    Add-Issue $Issues "manager" "error" "Manager guarded recovery failed: $($_.Exception.Message)" "Retry backoff=${delaySeconds}s; the watchdog did not fall back to PATH node." $false $true
  }
}

function Get-Gateways {
  $payload = Invoke-Json -Path "/gateways" -TimeoutSec 8
  $data = Get-Prop $payload "data"
  $manager = Get-Prop $data "manager"
  if ($null -eq $manager) { return @() }
  return @($manager)
}

function Get-AdapterTypes {
  param([object]$Gateway)
  $types = [System.Collections.Generic.List[string]]::new()
  $primary = Get-Prop $Gateway "messageAdapterType"
  if ($primary) { $types.Add([string]$primary) | Out-Null }
  foreach ($item in @((Get-Prop $Gateway "messageAdapters"))) {
    if ($item) { $types.Add([string]$item) | Out-Null }
  }
  return @($types | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ } | Select-Object -Unique)
}

function Invoke-GatewayAction {
  param(
    [object]$Gateway,
    [string]$Action,
    [System.Collections.Generic.List[object]]$Issues
  )
  if ($NoRepair) { return $false }
  $id = [uri]::EscapeDataString([string](Get-Prop $Gateway "id"))
  try {
    Invoke-Json -Path "/gateways/$id/$Action" -Method "Post" -TimeoutSec 15 | Out-Null
    return $true
  } catch {
    Add-Issue $Issues ([string](Get-Prop $Gateway "id")) "error" "Gateway $Action failed: $($_.Exception.Message)" "" $false $false
    return $false
  }
}

function Get-TrayProcesses {
  $scriptNeedle = "desktop\tray-task-window\main.py"
  $exeNeedle = "rabiroute-tray.exe"
  try {
    $matches = @(Get-CimInstance Win32_Process | Where-Object {
      ($_.Name -eq "RabiRoute-Tray.exe") -or
      ($_.CommandLine -and ($_.CommandLine.ToLowerInvariant().Contains($scriptNeedle) -or $_.CommandLine.ToLowerInvariant().Contains($exeNeedle)))
    })
    $matchedPids = @{}
    foreach ($process in $matches) {
      $matchedPids[[int]$process.ProcessId] = $true
    }
    $roots = @($matches | Where-Object {
      -not $matchedPids.ContainsKey([int]$_.ParentProcessId)
    })
    Write-HealthLog "Tray process query: matches=$($matches.Count) roots=$($roots.Count)"
    return $roots
  } catch {
    Write-HealthLog "Tray process query failed: $($_.Exception.Message)"
    return @()
  }
}

function Stop-DuplicateTrayProcesses {
  param(
    [array]$TrayProcesses,
    [System.Collections.Generic.List[object]]$Issues
  )
  if ($TrayProcesses.Count -le 1) { return @($TrayProcesses) }

  $pids = ($TrayProcesses | ForEach-Object { $_.ProcessId }) -join ", "
  Add-Issue $Issues "tray" "warning" "Multiple tray processes were found." "Observed pid(s): $pids. Left them running because the tray may use a parent/child process group." $false $false
  return @($TrayProcesses)
}

function Ensure-Tray {
  param([System.Collections.Generic.List[object]]$Issues)
  $trayProcesses = @(Get-TrayProcesses)
  if ($trayProcesses.Count -gt 1 -and -not $NoRepair) {
    $trayProcesses = Stop-DuplicateTrayProcesses $trayProcesses $Issues
  }
  if ($trayProcesses.Count -gt 0) {
    return
  }

  if ($NoRepair -or $NoTrayRepair) {
    Add-Issue $Issues "tray" "warning" "RabiRoute tray process was not found." "NoRepair/NoTrayRepair mode; no auto-start." $false $false
    return
  }

  $launcher = Join-Path $ProjectRoot "Start-RabiRoute-Tray.bat"
  if (-not (Test-Path $launcher)) {
    Add-Issue $Issues "tray" "warning" "RabiRoute tray process was not found and launcher is missing." "" $false $true
    return
  }

  try {
    Start-Process -FilePath $launcher -ArgumentList @("-NoOpen", "-NoBuild", "-UseExistingBuild", "-ReuseHealthyManager") -WorkingDirectory $ProjectRoot -WindowStyle Hidden | Out-Null
    $afterStart = @()
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
      Start-Sleep -Seconds 2
      $afterStart = @(Get-TrayProcesses)
      if ($afterStart.Count -gt 0) { break }
    }
    if ($afterStart.Count -gt 1) {
      $afterStart = Stop-DuplicateTrayProcesses $afterStart $Issues
    }
    if ($afterStart.Count -gt 0) {
      Add-Issue $Issues "tray" "warning" "RabiRoute tray process was not found." "Started Start-RabiRoute-Tray.bat -NoOpen -NoBuild." $true $false
    } else {
      Add-Issue $Issues "tray" "warning" "Tray process was still missing after auto-start." "Check the tray app manually." $false $true
    }
  } catch {
    Add-Issue $Issues "tray" "warning" "Tray auto-start failed: $($_.Exception.Message)" "" $false $true
  }
}

function Remove-IgnoredNapcatKeys {
  param(
    [object]$Gateway,
    [object]$Instance
  )

  $configName = [string](Get-Prop $Gateway "configName")
  if (-not $configName) {
    $configName = [string](Get-Prop $Gateway "id")
  }
  if (-not $configName) { return $false }
  $path = Join-Path $ProjectRoot "data\route\$configName\adapterConfig.json"
  if (-not (Test-Path $path)) { return $false }

  $instanceId = [string](Get-Prop $Instance "id")
  $gatewayPort = [string](Get-Prop $Instance "gatewayPort")
  $httpUrl = [string](Get-Prop $Instance "httpUrl")
  $webuiUrl = [string](Get-Prop $Instance "webuiUrl")
  $botUserId = [string](Get-Prop $Instance "botUserId")
  $blocked = @("id:$instanceId", "ws:$gatewayPort", "http:$httpUrl", "webui:$webuiUrl", "qq:$botUserId") | Where-Object { $_ -and $_ -notmatch ":$" }

  $json = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
  $current = @((Get-Prop $json "ignoredNapcatInstanceIds"))
  if ($current.Count -eq 0) { return $false }
  $next = @($current | Where-Object { $blocked -notcontains [string]$_ })
  if ($next.Count -eq $current.Count) { return $false }

  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  Copy-Item -LiteralPath $path -Destination "$path.bak-$timestamp-health-watch" -Force
  $json.ignoredNapcatInstanceIds = @($next)
  $json | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $path -Encoding UTF8
  return $true
}

function New-NapcatBody {
  param([object]$Gateway, [object]$Instance)
  $body = @{
    gatewayId = [string](Get-Prop $Gateway "id")
    instanceId = [string](Get-Prop $Instance "id")
    httpUrl = [string](Get-Prop $Instance "httpUrl")
    webuiUrl = [string](Get-Prop $Instance "webuiUrl")
    gatewayPort = [int](Get-Prop $Instance "gatewayPort")
  }
  foreach ($name in @("accessToken", "webuiToken")) {
    $value = Get-Prop $Instance $name
    if ($value) { $body[$name] = [string]$value }
  }
  return $body
}

function Test-Napcat {
  param([object]$Gateway, [object]$Instance)
  return Invoke-Json -Path "/api/message/napcat-health" -Method "Post" -Body (New-NapcatBody -Gateway $Gateway -Instance $Instance) -TimeoutSec 14
}

function Repair-Napcat {
  param(
    [object]$Gateway,
    [object]$Instance,
    [object]$Health,
    [System.Collections.Generic.List[object]]$Issues
  )

  $gatewayId = [string](Get-Prop $Gateway "id")
  $instanceId = [string](Get-Prop $Instance "id")
  $scope = "$gatewayId/$instanceId"

  $webui = Get-Prop $Health "webui"
  $loginInfo = Get-Prop $webui "loginInfo"
  $currentUserId = [string](Get-Prop $loginInfo "userId")
  $http = Get-Prop $Health "http"
  $httpOk = (Get-Prop $http "ok") -eq $true
  if (-not $httpOk -and -not $currentUserId -and (Get-Prop $webui "reachable") -eq $true) {
    Add-Issue $Issues $scope "error" "NapCat WebUI is reachable, but current QQ login info is empty." "Manual login is required in WebUI/QQ; restart cannot replace authentication." $false $true -Impact "adapter" -Adapter "napcat"
    return
  }

  if ($NoRepair) {
    Add-Issue $Issues $scope "error" "NapCat is unhealthy." "NoRepair mode; skipped repair." $false $false -Impact "adapter" -Adapter "napcat"
    return
  }

  $ignoredChanged = $false
  try {
    $ignoredChanged = Remove-IgnoredNapcatKeys -Gateway $Gateway -Instance $Instance
  } catch {
    Add-Issue $Issues $scope "warning" "Failed to clear NapCat ignored keys: $($_.Exception.Message)" "" $false $false -Impact "adapter" -Adapter "napcat"
  }
  if ($ignoredChanged) {
    Add-Issue $Issues $scope "warning" "NapCat instance was blocked by ignoredNapcatInstanceIds." "Removed matching ignored keys from adapterConfig.json; waiting for manager reload." $true $false -Impact "adapter" -Adapter "napcat"
    Start-Sleep -Seconds 2
  }

  $body = New-NapcatBody -Gateway $Gateway -Instance $Instance
  if ((Get-Prop $Health "fixAvailable") -eq $true) {
    try {
      Invoke-Json -Path "/api/message/napcat-configure-onebot" -Method "Post" -Body $body -TimeoutSec 45 | Out-Null
      Add-Issue $Issues $scope "error" "NapCat OneBot config is missing or inactive." "Tried to write and apply OneBot HTTP/WS config." $true $false -Impact "adapter" -Adapter "napcat"
    } catch {
      Add-Issue $Issues $scope "error" "NapCat OneBot config repair failed: $($_.Exception.Message)" "" $false $false -Impact "adapter" -Adapter "napcat"
    }
  }

  try {
    $result = Invoke-Json -Path "/api/message/napcat-restart" -Method "Post" -Body @{
      gatewayId = $gatewayId
      instanceId = $instanceId
    } -TimeoutSec 70 -AllowHttpError
    # The lifecycle endpoint can legitimately report that its launcher started
    # once WebUI appears, while OneBot HTTP is still offline.  Do not turn that
    # into a false recovery in the watchdog summary; read the live endpoints
    # back after the bounded restart/launch operation completes.
    $reportedOk = (Get-Prop $result.body "ok") -eq $true
    $after = $null
    try {
      $after = Test-Napcat -Gateway $Gateway -Instance $Instance
    } catch {
      Add-Issue $Issues $scope "error" "NapCat restart finished but post-restart health read-back failed." "Manager reported launcher result=$reportedOk; endpoint verification could not complete." $false $false -Impact "adapter" -Adapter "napcat"
      return
    }
    $ok = (Get-Prop $after "ok") -eq $true
    if ($ok) {
      Add-Issue $Issues $scope "error" "NapCat is unhealthy." "Restart/launch completed and live OneBot health read-back is now healthy." $true $false -Impact "adapter" -Adapter "napcat"
    } else {
      $afterHttp = Get-Prop $after "http"
      $afterWebui = Get-Prop $after "webui"
      $httpReachable = (Get-Prop $afterHttp "ok") -eq $true
      $webuiReachable = (Get-Prop $afterWebui "reachable") -eq $true
      Add-Issue $Issues $scope "error" "NapCat remains unhealthy after guarded restart/launch." "Post-restart read-back: onebot=$httpReachable webui=$webuiReachable; no success was inferred from the launch command alone." $false $false -Impact "adapter" -Adapter "napcat"
    }
  } catch {
    Add-Issue $Issues $scope "error" "NapCat restart request failed: $($_.Exception.Message)" "" $false $false -Impact "adapter" -Adapter "napcat"
  }
}

function Check-Gateways {
  param(
    [object[]]$Gateways,
    [System.Collections.Generic.List[object]]$Issues
  )

  foreach ($gateway in $Gateways) {
    $gatewayId = [string](Get-Prop $gateway "id")
    $enabled = (Get-Prop $gateway "enabled") -ne $false
    if (-not $enabled -and -not $IncludeDisabled) { continue }

    $running = (Get-Prop $gateway "running") -eq $true
    if ($enabled -and -not $running) {
      if (Invoke-GatewayAction -Gateway $gateway -Action "start" -Issues $Issues) {
        Add-Issue $Issues $gatewayId "error" "Enabled gateway is not running." "Requested gateway start." $true $false
      }
      continue
    }

    $adapters = Get-AdapterTypes -Gateway $gateway
    if ($enabled -and $adapters -contains "heartbeat") {
      $heartbeat = Get-Prop (Get-Prop $gateway "gatewayStatus") "heartbeat"
      $nextTickAt = [string](Get-Prop $heartbeat "nextTickAt")
      if (-not $nextTickAt) {
        if (Invoke-GatewayAction -Gateway $gateway -Action "restart" -Issues $Issues) {
          Add-Issue $Issues $gatewayId "warning" "Heartbeat is enabled but nextTickAt is missing." "Requested gateway restart to rebuild timers." $true $false
        }
      } else {
        try {
          $next = [datetime]::Parse($nextTickAt)
          if ($next.ToUniversalTime() -lt (Get-Date).ToUniversalTime().AddMinutes(-5)) {
            if (Invoke-GatewayAction -Gateway $gateway -Action "restart" -Issues $Issues) {
              Add-Issue $Issues $gatewayId "warning" "Heartbeat nextTickAt is stale: $nextTickAt." "Requested gateway restart to rebuild timers." $true $false
            }
          }
        } catch {
          Add-Issue $Issues $gatewayId "warning" "Heartbeat nextTickAt is not parseable: $nextTickAt." "" $false $false
        }
      }
    }

    if ($enabled -and $adapters -contains "napcat") {
      foreach ($instance in @((Get-Prop $gateway "napcatInstances"))) {
        if ($null -eq $instance) { continue }
        if ((Get-Prop $instance "enabled") -eq $false -and -not $IncludeDisabled) { continue }
        $scope = "$gatewayId/$([string](Get-Prop $instance 'id'))"
        try {
          $health = Test-Napcat -Gateway $gateway -Instance $instance
          if ((Get-Prop $health "ok") -eq $true) { continue }
          $message = [string](Get-Prop $health "message")
          if (-not $message) {
            $http = Get-Prop $health "http"
            $message = [string](Get-Prop $http "message")
          }
          Add-Issue $Issues $scope "error" "NapCat health check failed: $message" "Starting repair decision." $false $false -Impact "adapter" -Adapter "napcat"
          Repair-Napcat -Gateway $gateway -Instance $instance -Health $health -Issues $Issues
        } catch {
          Add-Issue $Issues $scope "error" "NapCat health check threw: $($_.Exception.Message)" "" $false $false -Impact "adapter" -Adapter "napcat"
        }
      }
    }

    $agentStates = Get-Prop $gateway "agentStates"
    $codexAgentState = $null
    if ($agentStates) {
      $codexAgentState = Get-Prop $agentStates "codex"
    }
    $agentAdapters = @((Get-Prop $gateway "agentAdapters"))
    $codexError = [string](Get-Prop $codexAgentState "lastNotificationError")
    if ($enabled -and ($agentAdapters -contains "codex") -and $codexError) {
      $action = "Open Codex/ChatGPT Desktop, rescan the target task, then check Desktop IPC readiness, codexThreadId, and codexCwd. RabiRoute will not start a fallback runtime."
      Add-Issue $Issues $gatewayId "error" "Codex delivery failed: $codexError" $action $false $true
    }
  }
}

function Save-Summary {
  param(
    [datetime]$StartedAt,
    [object]$Meta,
    [object]$ManagerProbe,
    [object[]]$Gateways,
    [System.Collections.Generic.List[object]]$Issues
  )

  $finishedAt = Get-Date
  $systemErrors = @($Issues | Where-Object { $_.severity -eq "error" -and $_.impact -ne "adapter" })
  $adapterErrors = @($Issues | Where-Object { $_.severity -eq "error" -and $_.impact -eq "adapter" })
  $status = if ($Issues.Count -eq 0) {
    "ok"
  } elseif ($systemErrors.Count -gt 0) {
    "error"
  } elseif ($adapterErrors.Count -gt 0) {
    "degraded"
  } else {
    "warning"
  }
  $record = [pscustomobject]@{
    time = [int][double]::Parse((Get-Date -UFormat %s))
    startedAt = $StartedAt.ToString("o")
    finishedAt = $finishedAt.ToString("o")
    status = $status
    manager = $Meta
    managerProbe = $ManagerProbe
    gatewayCount = @($Gateways).Count
    systemErrorCount = $systemErrors.Count
    adapterErrorCount = $adapterErrors.Count
    issues = @($Issues)
  }
  Add-Content -LiteralPath $JsonlLogPath -Encoding UTF8 -Value ($record | ConvertTo-Json -Depth 20 -Compress)

  $lines = [System.Collections.Generic.List[string]]::new()
  $lines.Add("# RabiRoute Health Patrol") | Out-Null
  $lines.Add("") | Out-Null
  $lines.Add("- Time: $($finishedAt.ToString('yyyy-MM-dd HH:mm:ss zzz'))") | Out-Null
  $lines.Add("- Status: $status") | Out-Null
  $lines.Add("- Manager: $([string](Get-Prop $Meta 'version')) $ManagerUrl") | Out-Null
  $lines.Add("- Gateway count: $(@($Gateways).Count)") | Out-Null
  $lines.Add("") | Out-Null
  $lines.Add("## Gateway Snapshot") | Out-Null
  foreach ($gateway in @($Gateways)) {
    $heartbeat = Get-Prop (Get-Prop $gateway "gatewayStatus") "heartbeat"
    $napcat = Get-Prop (Get-Prop $gateway "gatewayStatus") "napcat"
    $line = "- $([string](Get-Prop $gateway 'id')): running=$([bool](Get-Prop $gateway 'running')) adapters=$((Get-AdapterTypes $gateway) -join '+')"
    if ($heartbeat) { $line += " nextTick=$([string](Get-Prop $heartbeat 'nextTickAt'))" }
    if ($napcat) { $line += " napcatConnected=$([string](Get-Prop $napcat 'connected')) online=$([string](Get-Prop $napcat 'online'))" }
    $lines.Add($line) | Out-Null
  }
  $lines.Add("") | Out-Null
  $lines.Add("## Issues And Repairs") | Out-Null
  if ($Issues.Count -eq 0) {
    $lines.Add("- No obvious issues found.") | Out-Null
  } else {
    foreach ($issue in @($Issues)) {
      $suffix = if ($issue.needsUser) { "; needs user action" } elseif ($issue.repaired) { "; repair attempted" } else { "" }
      $lines.Add("- [$($issue.severity)] $($issue.scope): $($issue.message) $($issue.action)$suffix") | Out-Null
    }
  }
  Set-Content -LiteralPath $LatestSummaryPath -Encoding UTF8 -Value $lines
  Write-HealthLog "Cycle status=$status issues=$($Issues.Count) summary=$LatestSummaryPath"
}

function Invoke-HealthCycle {
  $startedAt = Get-Date
  $issues = [System.Collections.Generic.List[object]]::new()
  Write-HealthLog "Health cycle started. interval=${IntervalSeconds}s once=$Once noRepair=$NoRepair"

  $managerProbe = Test-ManagerWithRetry
  $meta = $managerProbe.meta
  if (-not $meta) {
    $detail = if ($managerProbe.classification -eq "control_plane_unresponsive") {
      "Manager listener is present but /meta failed after $($managerProbe.attempts) bounded probes."
    } else {
      "Manager process/listener is absent after $($managerProbe.attempts) bounded probes."
    }
    Add-Issue $issues "manager" "error" $detail "Trying guarded manager recovery." $false $false
    Start-ManagerIfNeeded -Issues $issues
    $meta = Test-Manager
  }

  $gateways = @()
  if ($meta) {
    Reset-ManagerRecoveryBackoff
    Ensure-Tray -Issues $issues
    try {
      $gateways = Get-Gateways
      Check-Gateways -Gateways $gateways -Issues $issues
    } catch {
      Add-Issue $issues "manager" "error" "Gateway read or patrol failed: $($_.Exception.Message)" "" $false $false
    }
  }

  Save-Summary -StartedAt $startedAt -Meta $meta -ManagerProbe $managerProbe -Gateways $gateways -Issues $issues
}

function Get-WatchdogMutexName {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($ProjectRoot.ToLowerInvariant())
    $hash = ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").Substring(0, 20)
    return "Local\RabiRouteHealthWatchdog-$hash"
  } finally {
    $sha.Dispose()
  }
}

$watchdogMutex = New-Object System.Threading.Mutex($false, (Get-WatchdogMutexName))
$ownsWatchdogMutex = $false
try {
  try {
    $ownsWatchdogMutex = $watchdogMutex.WaitOne(0)
  } catch [System.Threading.AbandonedMutexException] {
    $ownsWatchdogMutex = $true
  }
  if (-not $ownsWatchdogMutex) {
    Write-HealthLog "Another watchdog for this project is already running; duplicate invocation exited."
    exit 0
  }

  Write-HealthLog "RabiRoute health watchdog started. manager=$ManagerUrl interval=${IntervalSeconds}s once=$Once noRepair=$NoRepair noTrayRepair=$NoTrayRepair"

  do {
    try {
      Invoke-HealthCycle
    } catch {
      Write-HealthLog "Health cycle crashed: $($_.Exception.Message)"
    }

    if (-not $Once) {
      Start-Sleep -Seconds $IntervalSeconds
    }
  } while (-not $Once)
} finally {
  if ($ownsWatchdogMutex) {
    $watchdogMutex.ReleaseMutex()
  }
  $watchdogMutex.Dispose()
  Write-HealthLog "RabiRoute health watchdog stopped."
}
