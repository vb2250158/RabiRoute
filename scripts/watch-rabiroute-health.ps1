param(
  [string]$ManagerUrl = "http://127.0.0.1:8790",
  [string]$DefaultRouteName = "default-main",
  [int]$IntervalSeconds = 1800,
  [switch]$Once,
  [switch]$NoRepair,
  [switch]$IncludeDisabled,
  [switch]$NoTrayRepair
)

$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$LogsDir = Join-Path $ProjectRoot "data\route\$DefaultRouteName\logs"
New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null

$TextLogPath = Join-Path $LogsDir "rabiroute-health-watch.log"
$JsonlLogPath = Join-Path $LogsDir "rabiroute-health-watch.jsonl"
$LatestSummaryPath = Join-Path $LogsDir "rabiroute-health-latest.md"
$ManagerOutLog = Join-Path $ProjectRoot "rabiroute-manager-health.out.log"
$ManagerErrLog = Join-Path $ProjectRoot "rabiroute-manager-health.err.log"

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
    [bool]$NeedsUser = $false
  )
  $Issues.Add([pscustomobject]@{
    scope = $Scope
    severity = $Severity
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

function Start-ManagerIfNeeded {
  param([System.Collections.Generic.List[object]]$Issues)
  if ($NoRepair) { return }
  $managerJs = Join-Path $ProjectRoot "dist\manager.js"
  if (-not (Test-Path $managerJs)) {
    Add-Issue $Issues "manager" "error" "Manager is unreachable and dist\manager.js is missing." "Cannot auto-start before build." $false $true
    return
  }
  try {
    Start-Process -FilePath "node" -ArgumentList @($managerJs) -WorkingDirectory $ProjectRoot -RedirectStandardOutput $ManagerOutLog -RedirectStandardError $ManagerErrLog -WindowStyle Hidden | Out-Null
    Start-Sleep -Seconds 5
    if (Test-Manager) {
      Add-Issue $Issues "manager" "error" "Manager was unreachable." "Auto-started node dist\manager.js." $true $false
    } else {
      Add-Issue $Issues "manager" "error" "Manager stayed unreachable after auto-start." "Check rabiroute-manager-health.err.log." $false $true
    }
  } catch {
    Add-Issue $Issues "manager" "error" "Manager auto-start failed: $($_.Exception.Message)" "" $false $true
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
    Start-Process -FilePath $launcher -ArgumentList @("-NoOpen", "-NoBuild") -WorkingDirectory $ProjectRoot -WindowStyle Hidden | Out-Null
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

  $ignoredChanged = $false
  try {
    $ignoredChanged = Remove-IgnoredNapcatKeys -Gateway $Gateway -Instance $Instance
  } catch {
    Add-Issue $Issues $scope "warning" "Failed to clear NapCat ignored keys: $($_.Exception.Message)" "" $false $false
  }
  if ($ignoredChanged) {
    Add-Issue $Issues $scope "warning" "NapCat instance was blocked by ignoredNapcatInstanceIds." "Removed matching ignored keys from adapterConfig.json; waiting for manager reload." $true $false
    Start-Sleep -Seconds 2
  }

  $webui = Get-Prop $Health "webui"
  $loginInfo = Get-Prop $webui "loginInfo"
  $currentUserId = [string](Get-Prop $loginInfo "userId")
  $http = Get-Prop $Health "http"
  $httpOk = (Get-Prop $http "ok") -eq $true
  if (-not $httpOk -and -not $currentUserId -and (Get-Prop $webui "reachable") -eq $true) {
    Add-Issue $Issues $scope "error" "NapCat WebUI is reachable, but current QQ login info is empty." "Manual login is required in WebUI/QQ; restart cannot replace authentication." $false $true
    return
  }

  if ($NoRepair) {
    Add-Issue $Issues $scope "error" "NapCat is unhealthy." "NoRepair mode; skipped repair." $false $false
    return
  }

  $body = New-NapcatBody -Gateway $Gateway -Instance $Instance
  if ((Get-Prop $Health "fixAvailable") -eq $true) {
    try {
      Invoke-Json -Path "/api/message/napcat-configure-onebot" -Method "Post" -Body $body -TimeoutSec 45 | Out-Null
      Add-Issue $Issues $scope "error" "NapCat OneBot config is missing or inactive." "Tried to write and apply OneBot HTTP/WS config." $true $false
    } catch {
      Add-Issue $Issues $scope "error" "NapCat OneBot config repair failed: $($_.Exception.Message)" "" $false $false
    }
  }

  try {
    $result = Invoke-Json -Path "/api/message/napcat-restart" -Method "Post" -Body @{
      gatewayId = $gatewayId
      instanceId = $instanceId
    } -TimeoutSec 70 -AllowHttpError
    $ok = (Get-Prop $result.body "ok") -eq $true
    Add-Issue $Issues $scope "error" "NapCat is unhealthy." "Requested NapCat restart, ok=${ok}: $((Get-Prop $result.body 'message'))" $ok $false
  } catch {
    Add-Issue $Issues $scope "error" "NapCat restart request failed: $($_.Exception.Message)" "" $false $false
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
          Add-Issue $Issues $scope "error" "NapCat health check failed: $message" "Starting repair decision." $false $false
          Repair-Napcat -Gateway $gateway -Instance $instance -Health $health -Issues $Issues
        } catch {
          Add-Issue $Issues $scope "error" "NapCat health check threw: $($_.Exception.Message)" "" $false $false
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
    [object[]]$Gateways,
    [System.Collections.Generic.List[object]]$Issues
  )

  $finishedAt = Get-Date
  $status = if ($Issues.Count -eq 0) { "ok" } elseif (@($Issues | Where-Object { $_.severity -eq "error" }).Count -gt 0) { "error" } else { "warning" }
  $record = [pscustomobject]@{
    time = [int][double]::Parse((Get-Date -UFormat %s))
    startedAt = $StartedAt.ToString("o")
    finishedAt = $finishedAt.ToString("o")
    status = $status
    manager = $Meta
    gatewayCount = @($Gateways).Count
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

  $meta = Test-Manager
  if (-not $meta) {
    Add-Issue $issues "manager" "error" "Manager is unreachable: $ManagerUrl/meta." "Trying manager auto-start." $false $false
    Start-ManagerIfNeeded -Issues $issues
    $meta = Test-Manager
  }

  $gateways = @()
  if ($meta) {
    Ensure-Tray -Issues $issues
    try {
      $gateways = Get-Gateways
      Check-Gateways -Gateways $gateways -Issues $issues
    } catch {
      Add-Issue $issues "manager" "error" "Gateway read or patrol failed: $($_.Exception.Message)" "" $false $false
    }
  }

  Save-Summary -StartedAt $startedAt -Meta $meta -Gateways $gateways -Issues $issues
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

Write-HealthLog "RabiRoute health watchdog stopped."
