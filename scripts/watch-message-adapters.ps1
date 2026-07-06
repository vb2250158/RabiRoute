param(
  [string]$ManagerUrl = "http://127.0.0.1:8790",
  [string]$DefaultRouteName = "default-main",
  [int]$IntervalSeconds = 30,
  [int]$FailureThreshold = 2,
  [int]$RepairCooldownSeconds = 180,
  [int]$MaxConsecutiveRepairs = 3,
  [switch]$Once,
  [switch]$NoRepair,
  [switch]$IncludeDisabled,
  [switch]$ConfigureOneBotOnFailure
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$LogsDir = Join-Path $ProjectRoot "data\route\$DefaultRouteName\logs"
New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null
$LogPath = Join-Path $LogsDir "message-adapter-watchdog.log"
$FailureCounts = @{}
$LastRepairAt = @{}
$RepairAttempts = @{}
$RepairSuppressedLogged = @{}
$UnsupportedAdaptersLogged = @{}

function Write-WatchLog {
  param([string]$Message)
  $line = "[$(Get-Date -Format o)] $Message"
  Write-Host $line
  Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value $line
}

function Get-FailureCount {
  param([string]$Key)
  if ($FailureCounts.ContainsKey($Key)) {
    return [int]$FailureCounts[$Key]
  }
  return 0
}

function Add-FailureCount {
  param([string]$Key)
  $next = (Get-FailureCount -Key $Key) + 1
  $FailureCounts[$Key] = $next
  return $next
}

function Reset-AdapterState {
  param([string]$Key)
  $FailureCounts[$Key] = 0
  $RepairAttempts[$Key] = 0
  [void]$LastRepairAt.Remove($Key)
  [void]$RepairSuppressedLogged.Remove($Key)
}

function Get-PropertyValue {
  param(
    [object]$Object,
    [string]$Name
  )
  if ($null -eq $Object) {
    return $null
  }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) {
    return $null
  }
  return $property.Value
}

function Invoke-ManagerJson {
  param(
    [string]$Path,
    [string]$Method = "Get",
    [object]$Body = $null,
    [int]$TimeoutSec = 8
  )

  $arguments = @{
    Uri = "$ManagerUrl$Path"
    Method = $Method
    TimeoutSec = $TimeoutSec
  }
  if ($null -ne $Body) {
    $arguments.ContentType = "application/json; charset=utf-8"
    $arguments.Body = ($Body | ConvertTo-Json -Depth 8 -Compress)
  }
  return Invoke-RestMethod @arguments
}

function Get-GatewayRows {
  $payload = Invoke-ManagerJson -Path "/gateways" -TimeoutSec 5
  $data = Get-PropertyValue -Object $payload -Name "data"
  $managerRows = Get-PropertyValue -Object $data -Name "manager"
  if ($null -eq $managerRows) {
    return @()
  }
  return @($managerRows)
}

function Get-AdapterTypes {
  param([object]$Gateway)

  $types = [System.Collections.Generic.List[string]]::new()
  $primary = Get-PropertyValue -Object $Gateway -Name "messageAdapterType"
  if ($primary) {
    $types.Add([string]$primary)
  }
  $declared = Get-PropertyValue -Object $Gateway -Name "messageAdapters"
  foreach ($item in @($declared)) {
    if ($item) {
      $types.Add([string]$item)
    }
  }
  $instances = @(Get-PropertyValue -Object $Gateway -Name "napcatInstances")
  if ($types.Count -eq 0 -and $instances.Count -gt 0) {
    $types.Add("napcat")
  }
  return @($types | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ } | Select-Object -Unique)
}

function New-NapcatHealthBody {
  param(
    [object]$Gateway,
    [object]$Instance
  )

  $body = @{
    gatewayId = [string](Get-PropertyValue -Object $Gateway -Name "id")
    instanceId = [string](Get-PropertyValue -Object $Instance -Name "id")
    httpUrl = [string](Get-PropertyValue -Object $Instance -Name "httpUrl")
    webuiUrl = [string](Get-PropertyValue -Object $Instance -Name "webuiUrl")
    gatewayPort = [int](Get-PropertyValue -Object $Instance -Name "gatewayPort")
  }

  foreach ($name in @("accessToken", "webuiToken")) {
    $value = Get-PropertyValue -Object $Instance -Name $name
    if ($value) {
      $body[$name] = [string]$value
    }
  }

  return $body
}

function Test-NapcatAdapter {
  param(
    [object]$Gateway,
    [object]$Instance
  )

  $body = New-NapcatHealthBody -Gateway $Gateway -Instance $Instance
  $health = Invoke-ManagerJson -Path "/api/message/napcat-health" -Method "Post" -Body $body -TimeoutSec 10
  $http = Get-PropertyValue -Object $health -Name "http"
  $ok = (Get-PropertyValue -Object $health -Name "ok") -eq $true
  $httpOk = (Get-PropertyValue -Object $http -Name "ok") -eq $true
  $online = Get-PropertyValue -Object $http -Name "online"
  $good = Get-PropertyValue -Object $http -Name "good"
  $message = [string](Get-PropertyValue -Object $health -Name "message")
  if (-not $message) {
    $message = [string](Get-PropertyValue -Object $http -Name "message")
  }
  if (-not $message) {
    $message = "NapCat health returned ok=$ok httpOk=$httpOk online=$online good=$good"
  }

  return [pscustomobject]@{
    Adapter = "napcat"
    Healthy = [bool]($ok -and $httpOk -and $online -ne $false -and $good -ne $false)
    Message = $message
    Raw = $health
  }
}

function Repair-NapcatAdapter {
  param(
    [object]$Gateway,
    [object]$Instance,
    [object]$LastHealth
  )

  $gatewayId = [string](Get-PropertyValue -Object $Gateway -Name "id")
  $instanceId = [string](Get-PropertyValue -Object $Instance -Name "id")

  if ($ConfigureOneBotOnFailure) {
    try {
      Write-WatchLog "Configuring OneBot for gateway=$gatewayId instance=$instanceId"
      Invoke-ManagerJson -Path "/api/message/napcat-configure-onebot" -Method "Post" -Body (New-NapcatHealthBody -Gateway $Gateway -Instance $Instance) -TimeoutSec 12 | Out-Null
    } catch {
      Write-WatchLog "OneBot configure failed for gateway=$gatewayId instance=${instanceId}: $($_.Exception.Message)"
    }
  }

  Write-WatchLog "Restarting NapCat adapter gateway=$gatewayId instance=$instanceId"
  $result = Invoke-ManagerJson -Path "/api/message/napcat-restart" -Method "Post" -Body @{
    gatewayId = $gatewayId
    instanceId = $instanceId
  } -TimeoutSec 35
  $ok = (Get-PropertyValue -Object $result -Name "ok") -eq $true
  $message = [string](Get-PropertyValue -Object $result -Name "message")
  Write-WatchLog "NapCat restart result gateway=$gatewayId instance=${instanceId}: ok=$ok message=$message"
}

function Try-RepairNapcatAdapter {
  param(
    [string]$Key,
    [object]$Gateway,
    [object]$Instance,
    [object]$LastHealth
  )

  $gatewayId = [string](Get-PropertyValue -Object $Gateway -Name "id")
  $instanceId = [string](Get-PropertyValue -Object $Instance -Name "id")
  $now = Get-Date

  if ($LastRepairAt.ContainsKey($Key)) {
    $elapsed = ($now - [datetime]$LastRepairAt[$Key]).TotalSeconds
    if ($elapsed -lt $RepairCooldownSeconds) {
      $wait = [int][Math]::Ceiling($RepairCooldownSeconds - $elapsed)
      Write-WatchLog "Repair cooldown adapter=napcat gateway=$gatewayId instance=$instanceId wait=${wait}s"
      return $false
    }
  }

  $attempt = 0
  if ($RepairAttempts.ContainsKey($Key)) {
    $attempt = [int]$RepairAttempts[$Key]
  }
  if ($MaxConsecutiveRepairs -gt 0 -and $attempt -ge $MaxConsecutiveRepairs) {
    if (-not $RepairSuppressedLogged.ContainsKey($Key)) {
      $RepairSuppressedLogged[$Key] = $true
      Write-WatchLog "Repair suppressed adapter=napcat gateway=$gatewayId instance=$instanceId attempts=$attempt/$MaxConsecutiveRepairs until healthy"
    }
    return $false
  }

  Repair-NapcatAdapter -Gateway $Gateway -Instance $Instance -LastHealth $LastHealth
  $RepairAttempts[$Key] = $attempt + 1
  $LastRepairAt[$Key] = $now
  [void]$RepairSuppressedLogged.Remove($Key)
  return $true
}

function Watch-NapcatAdapters {
  param([object]$Gateway)

  $gatewayId = [string](Get-PropertyValue -Object $Gateway -Name "id")
  $gatewayEnabled = (Get-PropertyValue -Object $Gateway -Name "enabled") -ne $false
  if (-not $gatewayEnabled -and -not $IncludeDisabled) {
    Write-WatchLog "Skip disabled gateway=$gatewayId"
    return
  }

  $instances = @(Get-PropertyValue -Object $Gateway -Name "napcatInstances")
  if ($instances.Count -eq 0) {
    Write-WatchLog "Skip gateway=$gatewayId adapter=napcat: no configured instances"
    return
  }

  foreach ($instance in $instances) {
    $instanceId = [string](Get-PropertyValue -Object $instance -Name "id")
    $instanceEnabled = (Get-PropertyValue -Object $instance -Name "enabled") -ne $false
    $key = "napcat|$gatewayId|$instanceId"
    if (-not $instanceEnabled -and -not $IncludeDisabled) {
      [void]$FailureCounts.Remove($key)
      Write-WatchLog "Skip disabled NapCat instance gateway=$gatewayId instance=$instanceId"
      continue
    }

    try {
      $health = Test-NapcatAdapter -Gateway $Gateway -Instance $instance
      if ($health.Healthy) {
        Reset-AdapterState -Key $key
        Write-WatchLog "Healthy adapter=napcat gateway=$gatewayId instance=$instanceId"
        continue
      }

      $failureCount = Add-FailureCount -Key $key
      Write-WatchLog "Unhealthy adapter=napcat gateway=$gatewayId instance=$instanceId failure=$failureCount/$FailureThreshold message=$($health.Message)"
      if (-not $NoRepair -and $failureCount -ge $FailureThreshold) {
        [void](Try-RepairNapcatAdapter -Key $key -Gateway $Gateway -Instance $instance -LastHealth $health)
        $FailureCounts[$key] = 0
      }
    } catch {
      $failureCount = Add-FailureCount -Key $key
      Write-WatchLog "Adapter check failed adapter=napcat gateway=$gatewayId instance=$instanceId failure=$failureCount/$FailureThreshold error=$($_.Exception.Message)"
      if (-not $NoRepair -and $failureCount -ge $FailureThreshold) {
        [void](Try-RepairNapcatAdapter -Key $key -Gateway $Gateway -Instance $instance -LastHealth $null)
        $FailureCounts[$key] = 0
      }
    }
  }
}

function Watch-MessageAdaptersOnce {
  $gateways = Get-GatewayRows
  foreach ($gateway in $gateways) {
    $gatewayId = [string](Get-PropertyValue -Object $gateway -Name "id")
    foreach ($adapter in Get-AdapterTypes -Gateway $gateway) {
      switch ($adapter) {
        "napcat" { Watch-NapcatAdapters -Gateway $gateway }
        "onebot" { Watch-NapcatAdapters -Gateway $gateway }
        default {
          $unsupportedKey = "$gatewayId|$adapter"
          if (-not $UnsupportedAdaptersLogged.ContainsKey($unsupportedKey)) {
            $UnsupportedAdaptersLogged[$unsupportedKey] = $true
            Write-WatchLog "Skip unsupported message adapter gateway=$gatewayId adapter=$adapter"
          }
        }
      }
    }
  }
}

Write-WatchLog "Message adapter watchdog started. manager=$ManagerUrl interval=${IntervalSeconds}s threshold=$FailureThreshold repairCooldown=${RepairCooldownSeconds}s maxConsecutiveRepairs=$MaxConsecutiveRepairs once=$Once noRepair=$NoRepair includeDisabled=$IncludeDisabled configureOneBot=$ConfigureOneBotOnFailure"

do {
  try {
    Watch-MessageAdaptersOnce
  } catch {
    Write-WatchLog "Manager or watchdog cycle failed: $($_.Exception.Message)"
  }

  if (-not $Once) {
    Start-Sleep -Seconds $IntervalSeconds
  }
} while (-not $Once)

Write-WatchLog "Message adapter watchdog stopped."
