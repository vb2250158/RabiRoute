param(
  [string] $AccountToken = "",
  [string] $AccountId = "",
  [string] $Region = "cn",
  [string] $AgentId = "",
  [string] $CraftUrl = "",
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

  try {
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
  catch {
    throw ("CraftUrl is not a valid URL: {0}" -f $_.Exception.Message)
  }
}

function Invoke-CraftJsonRequest {
  param(
    [string] $Url,
    [hashtable] $Headers
  )

  $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $Url)
  foreach ($key in $Headers.Keys) {
    [void]$request.Headers.TryAddWithoutValidation($key, [string]$Headers[$key])
  }
  $client = [System.Net.Http.HttpClient]::new()
  try {
    $response = $client.SendAsync($request).GetAwaiter().GetResult()
    $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    return [pscustomobject]@{
      StatusCode = [int]$response.StatusCode
      IsSuccess = $response.IsSuccessStatusCode
      Text = $text
      Json = if ($text) { try { $text | ConvertFrom-Json } catch { $null } } else { $null }
    }
  }
  finally {
    $client.Dispose()
    $request.Dispose()
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

function Find-AgentRecords {
  param([object] $Node)

  $records = New-Object System.Collections.Generic.List[object]
  function Visit {
    param([object] $Value)
    if ($null -eq $Value) { return }

    if ($Value -is [System.Array] -or ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string] -and $Value -isnot [psobject])) {
      foreach ($item in $Value) { Visit $item }
      return
    }

    if ($Value -is [psobject]) {
      $id = Read-StringProperty -Value $Value -Names @("agentId", "botId", "id", "agent_id", "bot_id")
      $name = Read-StringProperty -Value $Value -Names @("agentName", "name", "title", "agent_name", "botName")
      $version = Read-StringProperty -Value $Value -Names @("version", "agentVersion", "agent_version")
      $summary = Read-StringProperty -Value $Value -Names @("description", "summary", "agentSummary", "desc")
      if ($id -or $name) {
        $records.Add([pscustomobject]@{
          id = $id
          name = $name
          version = $version
          summary = $summary
        }) | Out-Null
      }

      foreach ($property in $Value.PSObject.Properties) {
        if ($property.Value -is [string]) { continue }
        Visit $property.Value
      }
    }
  }

  Visit $Node
  return @($records)
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
$resolvedReportPath = Resolve-OptionalPath $ReportPath
$reportDir = Split-Path -Parent $resolvedReportPath
if (-not (Test-Path -LiteralPath $reportDir)) {
  New-Item -ItemType Directory -Path $reportDir | Out-Null
}

$AccountToken = Get-EnvOrValue -Value $AccountToken -EnvName "ROKID_CRAFT_ACCOUNT_TOKEN"
$AccountId = Get-EnvOrValue -Value $AccountId -EnvName "ROKID_CRAFT_ACCOUNT_ID"
$AgentId = Get-EnvOrValue -Value $AgentId -EnvName "ROKID_CRAFT_AGENT_ID"
$CraftUrl = Get-EnvOrValue -Value $CraftUrl -EnvName "ROKID_CRAFT_URL"
$craftUrlContext = Resolve-CraftUrlContext -Url $CraftUrl
if (-not $AgentId -and $craftUrlContext.AgentId) {
  $AgentId = $craftUrlContext.AgentId
}
if ($craftUrlContext.Region) {
  $Region = $craftUrlContext.Region
}
$normalizedRegion = if ($Region -eq "global") { "global" } else { "cn" }
$agentsUrl = "https://js.rokid.com/api/craft/project/agents"

$report = [ordered]@{
  generated_at = (Get-Date).ToUniversalTime().ToString("o")
  endpoint = $agentsUrl
  region = $normalizedRegion
  account_token_present = [bool]$AccountToken
  account_id_present = [bool]$AccountId
  craft_url_present = [bool]$CraftUrl
  expected = [ordered]@{
    agent_id = $AgentId
    agent_name = $AgentName
    version = $ExpectedVersion
  }
  http_status = 0
  matched = $false
  matches = @()
  visible_agent_count = 0
  error = ""
}

if (-not $AccountToken) {
  $report.error = "ROKID_CRAFT_ACCOUNT_TOKEN or -AccountToken is required."
  $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resolvedReportPath -Encoding UTF8
  Write-Output ("Wrote Craft status report: {0}" -f $resolvedReportPath)
  Write-Output $report.error
  exit 1
}

$headers = @{
  Accept = "application/json"
  "X-Account-Token" = $AccountToken
  "X-Craft-Region" = $normalizedRegion
}
if ($AccountId) {
  $headers["X-Account-ID"] = $AccountId
}

$result = Invoke-CraftJsonRequest -Url $agentsUrl -Headers $headers
$report.http_status = $result.StatusCode
if (-not $result.IsSuccess) {
  $report.error = if ($result.Text) { $result.Text } else { "Craft agents request failed." }
  $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resolvedReportPath -Encoding UTF8
  Write-Output ("Wrote Craft status report: {0}" -f $resolvedReportPath)
  Write-Output ("Craft agents HTTP status: {0}" -f $result.StatusCode)
  exit 1
}

$agents = Find-AgentRecords -Node $result.Json
$matches = @($agents | Where-Object {
  (($AgentId -and $_.id -eq $AgentId) -or ($AgentName -and $_.name -like "*$AgentName*"))
})
$report.visible_agent_count = @($agents).Count
$report.matches = $matches
$report.matched = $matches.Count -gt 0

$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resolvedReportPath -Encoding UTF8

Write-Output ("Wrote Craft status report: {0}" -f $resolvedReportPath)
Write-Output ("Craft agents HTTP status: {0}" -f $result.StatusCode)
Write-Output ("Visible agent records: {0}" -f $report.visible_agent_count)
Write-Output ("Matched RabiLink AIUI: {0}" -f $report.matched)
if ($matches.Count -gt 0) {
  $matches | Select-Object -First 5 | ConvertTo-Json -Depth 4
}
