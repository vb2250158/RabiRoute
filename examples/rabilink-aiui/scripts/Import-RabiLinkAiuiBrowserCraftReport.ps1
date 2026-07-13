param(
  [string] $BrowserReportPath = "",
  [string] $CraftUrl = "",
  [string] $AgentId = "",
  [string] $AgentName = "",
  [string] $ExpectedVersion = "",
  [string] $ReportPath = ""
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "RabiLinkAiuiCraftMetadata.ps1")

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

function Resolve-CraftUrlContext {
  param([string] $Url)

  if ([string]::IsNullOrWhiteSpace($Url)) {
    return [pscustomobject]@{
      AgentId = ""
      Region = ""
    }
  }

  $uri = [System.Uri]::new($Url.Trim())
  $query = @{}
  foreach ($part in $uri.Query.TrimStart("?").Split("&", [System.StringSplitOptions]::RemoveEmptyEntries)) {
    $pieces = $part.Split("=", 2)
    if ($pieces.Count -lt 1 -or [string]::IsNullOrWhiteSpace($pieces[0])) { continue }
    $key = [System.Uri]::UnescapeDataString($pieces[0].Replace("+", " "))
    $value = if ($pieces.Count -gt 1) { [System.Uri]::UnescapeDataString($pieces[1].Replace("+", " ")) } else { "" }
    $query[$key] = $value
  }
  $agentId = ""
  foreach ($key in @("defaultAgentId", "agentId", "botId", "id")) {
    $value = if ($query.ContainsKey($key)) { [string]$query[$key] } else { "" }
    if (-not [string]::IsNullOrWhiteSpace($value)) {
      $agentId = $value.Trim()
      break
    }
  }
  $region = if ($query.ContainsKey("region")) { [string]$query["region"] } else { "" }
  return [pscustomobject]@{
    AgentId = $agentId
    Region = if ([string]::IsNullOrWhiteSpace($region)) { "" } else { $region.Trim() }
  }
}

function Read-StringProperty {
  param(
    [object] $Value,
    [string[]] $Names
  )

  if (-not $Value -or $Value -isnot [psobject]) { return "" }
  foreach ($name in $Names) {
    if ($Value.PSObject.Properties.Name -contains $name) {
      $raw = $Value.$name
      if ($null -ne $raw -and -not [string]::IsNullOrWhiteSpace([string]$raw)) {
        return ([string]$raw).Trim()
      }
    }
  }
  return ""
}

function Normalize-MatchRecord {
  param([object] $Value)

  [pscustomobject]@{
    id = Read-StringProperty -Value $Value -Names @("id", "agentId", "botId", "agent_id", "bot_id")
    name = Read-StringProperty -Value $Value -Names @("name", "agentName", "title", "agent_name", "botName")
    version = Read-StringProperty -Value $Value -Names @("version", "agentVersion", "agent_version")
    summary = Read-StringProperty -Value $Value -Names @("summary", "description", "agentSummary", "desc")
  }
}

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$craftRelease = Read-RabiLinkAiuiCraftRelease -ProjectRoot $projectRoot
if (-not $AgentName) { $AgentName = ([string]$craftRelease.agentName).Trim() }
if (-not $ExpectedVersion) { $ExpectedVersion = ([string]$craftRelease.version).Trim() }
if (-not $ReportPath) {
  $ReportPath = if (Test-Path -LiteralPath (Join-Path $projectRoot "package.json")) {
    Join-Path $projectRoot "dist\craft-upload-status.json"
  } else {
    Join-Path $projectRoot "craft-upload-status.json"
  }
}
if (-not $BrowserReportPath) {
  $downloadPath = Join-Path ([Environment]::GetFolderPath("UserProfile")) "Downloads\rabilink-aiui-craft-upload-report.json"
  if (Test-Path -LiteralPath $downloadPath) {
    $BrowserReportPath = $downloadPath
  }
}

$CraftUrl = Get-EnvOrValue -Value $CraftUrl -EnvName "ROKID_CRAFT_URL"
$AgentId = Get-EnvOrValue -Value $AgentId -EnvName "ROKID_CRAFT_AGENT_ID"
$craftUrlContext = Resolve-CraftUrlContext -Url $CraftUrl
if (-not $AgentId -and $craftUrlContext.AgentId) {
  $AgentId = $craftUrlContext.AgentId
}
$expectedRegion = if ($craftUrlContext.Region) { $craftUrlContext.Region } else { "cn" }

if (-not $BrowserReportPath) {
  throw "BrowserReportPath is required, or place rabilink-aiui-craft-upload-report.json in the Downloads folder."
}
$resolvedBrowserReportPath = Resolve-OptionalPath $BrowserReportPath
if (-not (Test-Path -LiteralPath $resolvedBrowserReportPath)) {
  throw "Browser report is missing: $resolvedBrowserReportPath"
}

$browserReport = Get-Content -LiteralPath $resolvedBrowserReportPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($browserReport.source -ne "rabilink-aiui-craft-browser-upload-helper") {
  throw "Browser report source is not rabilink-aiui-craft-browser-upload-helper."
}

$reportExpectedAgentId = Read-StringProperty -Value $browserReport.expected -Names @("agent_id", "agentId")
if (-not $AgentId -and $reportExpectedAgentId) {
  $AgentId = $reportExpectedAgentId
}
$reportExpectedName = Read-StringProperty -Value $browserReport.expected -Names @("agent_name", "agentName")
if ($reportExpectedName) {
  $AgentName = $reportExpectedName
}
$reportExpectedVersion = Read-StringProperty -Value $browserReport.expected -Names @("version")
if ($reportExpectedVersion) {
  $ExpectedVersion = $reportExpectedVersion
}
$region = Read-StringProperty -Value $browserReport -Names @("region")
if (-not $region) { $region = $expectedRegion }
$normalizedRegion = if ($region -eq "global") { "global" } else { "cn" }

$matches = @()
if ($browserReport.list_agents -and $browserReport.list_agents.matches) {
  $matches = @($browserReport.list_agents.matches | ForEach-Object { Normalize-MatchRecord -Value $_ })
}
$listMatched = $browserReport.list_agents -and [bool]$browserReport.list_agents.matched
$uploadOk = $browserReport.upload -and [bool]$browserReport.upload.ok
$matched = [bool]$listMatched

$statusError = ""
if (-not [bool]$browserReport.session_present) {
  $statusError = "Browser report did not have a Craft session."
} elseif (-not $uploadOk) {
  $statusError = "Browser report does not show a successful upload."
} elseif (-not $matched) {
  $statusError = "Browser report upload succeeded, but agent listing did not prove RabiLink AIUI is visible in the account."
}
if ($browserReport.error -and -not $matched) {
  $statusError = [string]$browserReport.error
}

$resolvedReportPath = Resolve-OptionalPath $ReportPath
$reportDir = Split-Path -Parent $resolvedReportPath
if (-not (Test-Path -LiteralPath $reportDir)) {
  New-Item -ItemType Directory -Path $reportDir | Out-Null
}

$statusReport = [ordered]@{
  generated_at = (Get-Date).ToUniversalTime().ToString("o")
  endpoint = "https://js.rokid.com/api/craft/project/agents"
  region = $normalizedRegion
  account_token_present = $false
  account_id_present = [bool]$browserReport.account_id_parsed
  browser_session_present = [bool]$browserReport.session_present
  browser_report_path = $resolvedBrowserReportPath
  browser_report_generated_at = [string]$browserReport.generated_at
  craft_url_present = [bool]$CraftUrl
  expected = [ordered]@{
    agent_id = $AgentId
    agent_name = $AgentName
    version = $ExpectedVersion
  }
  http_status = if ($browserReport.list_agents) { [int]$browserReport.list_agents.http_status } else { 0 }
  upload_http_status = if ($browserReport.upload) { [int]$browserReport.upload.http_status } else { 0 }
  upload_ok = [bool]$uploadOk
  matched = $matched
  matches = $matches
  visible_agent_count = if ($browserReport.list_agents) { [int]$browserReport.list_agents.visible_agent_count } else { 0 }
  error = $statusError
}

$statusReport | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resolvedReportPath -Encoding UTF8

Write-Output ("Imported browser Craft report: {0}" -f $resolvedBrowserReportPath)
Write-Output ("Wrote Craft status report: {0}" -f $resolvedReportPath)
Write-Output ("Browser session present: {0}" -f $statusReport.browser_session_present)
Write-Output ("Upload OK: {0}" -f $statusReport.upload_ok)
Write-Output ("Matched RabiLink AIUI: {0}" -f $statusReport.matched)
if (-not $statusReport.matched) {
  Write-Output ("Status: {0}" -f $statusReport.error)
  exit 1
}
