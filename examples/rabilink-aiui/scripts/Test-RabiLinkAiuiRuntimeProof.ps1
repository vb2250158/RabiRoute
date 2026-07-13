param(
  [string] $RelayBaseUrl = "",
  [string] $Token = "",
  [string] $ReportPath = "",
  [int] $Limit = 20,
  [switch] $IncludeSmoke
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Net.Http

function Resolve-OptionalPath {
  param([string] $PathValue)
  if (-not $PathValue) { return "" }
  return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($PathValue)
}

function Get-EnvOrValue {
  param(
    [string] $Value,
    [string] $EnvName
  )
  if (-not [string]::IsNullOrWhiteSpace($Value)) { return $Value.Trim() }
  $envValue = [Environment]::GetEnvironmentVariable($EnvName)
  if (-not [string]::IsNullOrWhiteSpace($envValue)) { return $envValue.Trim() }
  return ""
}

function Normalize-RelayBaseUrl {
  param([string] $Value)
  $text = ""
  if (-not [string]::IsNullOrWhiteSpace($Value)) {
    $text = $Value.Trim().TrimEnd("/")
  }
  if (-not $text) { return "" }
  $uri = $null
  if (-not [System.Uri]::TryCreate($text, [System.UriKind]::Absolute, [ref] $uri)) {
    throw "RelayBaseUrl must be a valid URL."
  }
  return $uri.AbsoluteUri.TrimEnd("/")
}

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
if (-not $ReportPath) {
  $ReportPath = Join-Path $projectRoot "dist\runtime-proof-status.json"
}
$resolvedReportPath = Resolve-OptionalPath $ReportPath
$reportDir = Split-Path -Parent $resolvedReportPath
if (-not (Test-Path -LiteralPath $reportDir)) {
  New-Item -ItemType Directory -Path $reportDir | Out-Null
}

$RelayBaseUrl = Get-EnvOrValue -Value $RelayBaseUrl -EnvName "RABILINK_AIUI_RELAY_URL"
$Token = Get-EnvOrValue -Value $Token -EnvName "RABILINK_AIUI_TOKEN"
$normalizedRelayBaseUrl = Normalize-RelayBaseUrl $RelayBaseUrl

$report = [ordered]@{
  generated_at = (Get-Date).ToUniversalTime().ToString("o")
  relay_base_url = $normalizedRelayBaseUrl
  token_present = [bool]$Token
  endpoint = if ($normalizedRelayBaseUrl) { "$normalizedRelayBaseUrl/api/rabilink/mobile/proofs" } else { "" }
  http_status = 0
  accepted_events = @("app-start", "relay-connected", "pc-bound", "webgui-config-loaded", "webgui-config-saved")
  proved = $false
  proof_count = 0
  matched_proofs = @()
  latest_proof = $null
  error = ""
}

if (-not $normalizedRelayBaseUrl) {
  $report.error = "RABILINK_AIUI_RELAY_URL or -RelayBaseUrl is required."
  $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resolvedReportPath -Encoding UTF8
  Write-Output ("Wrote runtime proof report: {0}" -f $resolvedReportPath)
  Write-Output $report.error
  exit 1
}

if (-not $Token) {
  $report.error = "RABILINK_AIUI_TOKEN or -Token is required."
  $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resolvedReportPath -Encoding UTF8
  Write-Output ("Wrote runtime proof report: {0}" -f $resolvedReportPath)
  Write-Output $report.error
  exit 1
}

$uri = "{0}/api/rabilink/mobile/proofs?limit={1}" -f $normalizedRelayBaseUrl, ([Math]::Max(1, [Math]::Min(100, $Limit)))
$acceptedEvents = @("app-start", "relay-connected", "pc-bound", "webgui-config-loaded", "webgui-config-saved")
if ($IncludeSmoke) {
  $acceptedEvents += "smoke-runtime"
}
$report.accepted_events = $acceptedEvents
$request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $uri)
$request.Headers.TryAddWithoutValidation("X-RabiLink-Token", $Token) | Out-Null
$client = [System.Net.Http.HttpClient]::new()
try {
  $response = $client.SendAsync($request).GetAwaiter().GetResult()
  $report.http_status = [int]$response.StatusCode
  $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  $json = if ($text) { try { $text | ConvertFrom-Json } catch { $null } } else { $null }
  if (-not $response.IsSuccessStatusCode) {
    $report.error = if ($text) { $text } else { "Runtime proof request failed." }
  } elseif (-not $json -or -not ($json.PSObject.Properties.Name -contains "proofs")) {
    $report.error = "Runtime proof response did not include proofs."
  } else {
    $proofs = @($json.proofs)
    $matches = @($proofs | Where-Object {
      $runtimeName = [string]$_.runtime.appName
      $event = [string]$_.event
      $runtimeName -eq "RabiLink AIUI" -and $event -in $acceptedEvents
    })
    $report.proof_count = $proofs.Count
    $report.matched_proofs = $matches
    $report.latest_proof = if ($matches.Count -gt 0) { $matches[0] } else { $null }
    $report.proved = $matches.Count -gt 0
    if (-not $report.proved) {
      $report.error = "No RabiLink AIUI runtime proof was found."
    }
  }
}
finally {
  $client.Dispose()
  $request.Dispose()
}

$report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $resolvedReportPath -Encoding UTF8

Write-Output ("Wrote runtime proof report: {0}" -f $resolvedReportPath)
Write-Output ("HTTP status: {0}" -f $report.http_status)
Write-Output ("Runtime proof found: {0}" -f $report.proved)
if (-not $report.proved) {
  Write-Output ("Status: {0}" -f $report.error)
  exit 1
}
