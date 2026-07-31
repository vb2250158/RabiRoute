param(
  [string]$ManagerUrl = "http://127.0.0.1:8790",
  [int]$DurationSeconds = 300,
  [int]$IntervalSeconds = 5,
  [int]$RequestTimeoutSeconds = 4,
  [string]$DefaultRouteName = "default-main",
  [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"

if ($DurationSeconds -lt 1) { throw "DurationSeconds must be at least 1." }
if ($IntervalSeconds -lt 1) { throw "IntervalSeconds must be at least 1." }
if ($RequestTimeoutSeconds -lt 1) { throw "RequestTimeoutSeconds must be at least 1." }

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$logsDir = Join-Path $projectRoot "data\route\$DefaultRouteName\logs"
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
if (-not $OutputPath) {
  $OutputPath = Join-Path $logsDir ("manager-soak-{0}.jsonl" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
}

$env:NO_PROXY = (@(
  ([string]$env:NO_PROXY -split ",")
  ([string]$env:no_proxy -split ",")
  "127.0.0.1"
  "localhost"
  "::1"
) | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -Unique) -join ","
$env:no_proxy = $env:NO_PROXY
[System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy

$metaUrl = "$($ManagerUrl.TrimEnd('/'))/meta"
$managerPort = ([uri]$ManagerUrl).Port
$startedAt = Get-Date
$deadline = $startedAt.AddSeconds($DurationSeconds)
$samples = 0
$successes = 0
$failures = 0
$pidChanges = 0
$initialPid = $null
$lastPid = $null

do {
  $sampledAt = Get-Date
  $stopwatch = [Diagnostics.Stopwatch]::StartNew()
  $statusCode = 0
  $meta = $null
  $errorMessage = ""
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $metaUrl -TimeoutSec $RequestTimeoutSeconds
    $statusCode = [int]$response.StatusCode
    $meta = $response.Content | ConvertFrom-Json
  } catch {
    if ($_.Exception.Response) {
      try { $statusCode = [int]$_.Exception.Response.StatusCode } catch {}
    }
    $errorMessage = $_.Exception.Message
  }
  $stopwatch.Stop()

  $ownerPid = $null
  try {
    $ownerPid = [int](Get-NetTCPConnection -State Listen -LocalPort $managerPort -ErrorAction Stop |
      Sort-Object OwningProcess |
      Select-Object -First 1 -ExpandProperty OwningProcess)
  } catch {
  }

  if ($ownerPid) {
    if ($null -eq $initialPid) { $initialPid = $ownerPid }
    if ($null -ne $lastPid -and $lastPid -ne $ownerPid) { $pidChanges += 1 }
    $lastPid = $ownerPid
  }

  $ok = $statusCode -eq 200 -and $null -ne $meta
  if ($ok) { $successes += 1 } else { $failures += 1 }
  $samples += 1

  $record = [ordered]@{
    schemaVersion = 1
    eventId = [guid]::NewGuid().ToString()
    time = $sampledAt.ToString("o")
    ok = $ok
    statusCode = $statusCode
    latencyMs = [int]$stopwatch.ElapsedMilliseconds
    listeningPid = $ownerPid
    version = if ($meta) { $meta.version } else { $null }
    runtime = if ($meta) { $meta.managerRuntime } else { $null }
    relayState = if ($meta -and $meta.rabiLinkRelayRuntime) { $meta.rabiLinkRelayRuntime.state } else { $null }
    error = if ($errorMessage) { $errorMessage } else { $null }
  }
  Add-Content -LiteralPath $OutputPath -Encoding UTF8 -Value ($record | ConvertTo-Json -Depth 8 -Compress)

  if ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds $IntervalSeconds
  }
} while ((Get-Date) -lt $deadline)

$summary = [pscustomobject]@{
  startedAt = $startedAt.ToString("o")
  finishedAt = (Get-Date).ToString("o")
  durationSeconds = $DurationSeconds
  samples = $samples
  successes = $successes
  failures = $failures
  initialPid = $initialPid
  finalPid = $lastPid
  pidChanges = $pidChanges
  outputPath = $OutputPath
  passed = ($failures -eq 0 -and $pidChanges -eq 0)
}
$summary | ConvertTo-Json -Depth 4
if (-not $summary.passed) { exit 1 }
