param(
  [string] $AixPath = "",
  [string] $AccountToken = "",
  [string] $AccountId = "",
  [string] $Region = "cn",
  [string] $AgentId = "",
  [string] $CraftUrl = "",
  [string] $AgentName = "",
  [string] $Version = "",
  [string] $Description = "AI glasses control panel for bound PC RabiRoute WebGUI settings through RabiLink Relay.",
  [string] $IconUrl = "https://basecloud.rokidcdn.com/basecloud/prod/coze/default_agent_icon.png",
  [string] $Permissions = "RECORD_AUDIO,SPEECH_RECOGNITION,INTERNET",
  [string] $Category = "tool",
  [string] $ToolsJson = "",
  [switch] $ListAgents,
  [switch] $Execute
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "RabiLinkAiuiCraftMetadata.ps1")

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

function ConvertTo-SafeHeaderMap {
  param(
    [string] $Token,
    [string] $Id,
    [string] $CraftRegion
  )

  $headers = @{
    Accept = "application/json"
    "X-Craft-Region" = $CraftRegion
  }
  if ($Token) { $headers["X-Account-Token"] = $Token }
  if ($Id) { $headers["X-Account-ID"] = $Id }
  return $headers
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

function Invoke-CraftUpload {
  param(
    [string] $Url,
    [hashtable] $Headers,
    [string] $FilePath,
    [string] $MetadataJson
  )

  $fileBytes = [System.IO.File]::ReadAllBytes($FilePath)
  $client = [System.Net.Http.HttpClient]::new()
  $content = [System.Net.Http.MultipartFormDataContent]::new()
  $fileContent = [System.Net.Http.ByteArrayContent]::new($fileBytes)
  $fileContent.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse("application/octet-stream")
  $metadataContent = [System.Net.Http.StringContent]::new($MetadataJson, [System.Text.Encoding]::UTF8, "application/json")
  $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, $Url)
  try {
    $content.Add($fileContent, "file", [System.IO.Path]::GetFileName($FilePath))
    $content.Add($metadataContent, "metadata")
    $request.Content = $content
    foreach ($key in $Headers.Keys) {
      if ($key -ne "Accept") {
        [void]$request.Headers.TryAddWithoutValidation($key, [string]$Headers[$key])
      }
    }
    $response = $client.SendAsync($request).GetAwaiter().GetResult()
    $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    return [pscustomobject]@{
      StatusCode = [int]$response.StatusCode
      IsSuccess = $response.IsSuccessStatusCode
      Text = $text
    }
  }
  finally {
    $content.Dispose()
    $client.Dispose()
    $request.Dispose()
  }
}

function Write-SseSummary {
  param([string] $Text)

  if (-not $Text) { return }
  $events = @()
  $chunks = $Text -split "(`r?`n){2,}"
  foreach ($chunk in $chunks) {
    $eventName = "message"
    $dataLine = ""
    foreach ($line in ($chunk -split "`r?`n")) {
      if ($line.StartsWith("event:")) { $eventName = $line.Substring(6).Trim() }
      if ($line.StartsWith("data:")) { $dataLine = $line.Substring(5).Trim() }
    }
    if ($dataLine) {
      $message = $dataLine
      try {
        $json = $dataLine | ConvertFrom-Json
        if ($json.message) { $message = [string]$json.message }
        elseif ($json.stage) { $message = [string]$json.stage }
      }
      catch {}
      $events += ("{0}: {1}" -f $eventName, $message)
    }
  }
  if ($events.Count -gt 0) {
    Write-Output "Upload events:"
    $events | Select-Object -First 20 | ForEach-Object { Write-Output ("  " + $_) }
  }
}

function Get-SseUploadStatus {
  param([string] $Text)

  $complete = $false
  $hasError = $false
  $errors = @()
  $chunks = [regex]::Split([string]$Text, "(?:`r?`n){2,}")
  foreach ($chunk in $chunks) {
    if ([string]::IsNullOrWhiteSpace($chunk)) { continue }
    $eventName = "message"
    $dataLines = @()
    foreach ($line in ($chunk -split "`r?`n")) {
      if ($line.StartsWith("event:")) { $eventName = $line.Substring(6).Trim().ToLowerInvariant() }
      if ($line.StartsWith("data:")) { $dataLines += $line.Substring(5).TrimStart() }
    }
    $dataText = $dataLines -join "`n"
    $payload = $null
    if ($dataText) {
      try { $payload = $dataText | ConvertFrom-Json } catch {}
    }

    $stage = if ($payload -and $payload.stage) { ([string]$payload.stage).Trim().ToLowerInvariant() } else { "" }
    $status = if ($payload -and $payload.status) { ([string]$payload.status).Trim().ToLowerInvariant() } else { "" }
    if ($eventName -eq "done" -or $stage -eq "done" -or $status -eq "done" -or ($payload -and $payload.done -eq $true)) {
      $complete = $true
    }
    if ($eventName -eq "error" -or $stage -eq "error" -or $status -eq "error" -or ($payload -and $payload.error)) {
      $hasError = $true
      $message = if ($payload -and $payload.message) { [string]$payload.message } elseif ($dataText) { $dataText } else { $chunk.Trim() }
      $errors += $message
    }
  }

  return [pscustomobject]@{
    Complete = $complete
    HasError = $hasError
    Errors = $errors
  }
}

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
if (-not $AixPath) {
  $AixPath = Resolve-RabiLinkAiuiDefaultAixPath -ProjectRoot $projectRoot
}
$resolvedAixPath = Resolve-OptionalPath $AixPath

if (-not (Test-Path -LiteralPath $resolvedAixPath)) {
  throw "AIX package is missing: $resolvedAixPath"
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
$craftRelease = Read-RabiLinkAiuiCraftRelease -ProjectRoot $projectRoot
if (-not $AgentName) { $AgentName = ([string]$craftRelease.agentName).Trim() }
if (-not $Version) { $Version = ([string]$craftRelease.version).Trim() }

$normalizedRegion = if ($Region -eq "global") { "global" } else { "cn" }
$baseUrl = "https://js.rokid.com"
$agentsUrl = "$baseUrl/api/craft/project/agents"
$uploadUrl = "$baseUrl/api/craft/project/upload-agent"
$headers = ConvertTo-SafeHeaderMap -Token $AccountToken -Id $AccountId -CraftRegion $normalizedRegion

Write-Output ("AIX: {0}" -f $resolvedAixPath)
Write-Output ("AIX sha256: {0}" -f (Get-Sha256Hex $resolvedAixPath))
Write-Output ("Region: {0}" -f $normalizedRegion)
Write-Output ("Upload endpoint: {0}" -f $uploadUrl)
Write-Output ("Account token present: {0}" -f [bool]$AccountToken)
Write-Output ("Account ID present: {0}" -f [bool]$AccountId)
Write-Output ("Craft URL present: {0}" -f [bool]$CraftUrl)
Write-Output ("Agent ID resolved: {0}" -f [bool]$AgentId)

if ($ListAgents) {
  if (-not $AccountToken) {
    throw "ROKID_CRAFT_ACCOUNT_TOKEN or -AccountToken is required to list Craft agents."
  }
  $result = Invoke-CraftJsonRequest -Url $agentsUrl -Headers $headers
  Write-Output ("Agents HTTP status: {0}" -f $result.StatusCode)
  if (-not $result.IsSuccess) {
    Write-Output $result.Text
    exit 1
  }
  $result.Json | ConvertTo-Json -Depth 10
}

$permissionValues = @($Permissions -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$toolsJsonCompact = $ToolsJson.Trim()
if (-not $toolsJsonCompact -or $toolsJsonCompact -eq "[]") {
  $toolsJsonCompact = Get-RabiLinkAiuiCraftToolsJson -AixPath $resolvedAixPath
  Write-Output "Tools metadata: derived from pages/home/index.json inside the AIX."
}
Add-Type -AssemblyName System.Web.Extensions
$jsonSerializer = [System.Web.Script.Serialization.JavaScriptSerializer]::new()
$jsonSerializer.MaxJsonLength = [int]::MaxValue
$jsonSerializer.RecursionLimit = 100
try {
  $tools = $jsonSerializer.DeserializeObject($toolsJsonCompact)
}
catch {
  throw ("ToolsJson must be valid JSON: {0}" -f $_.Exception.Message)
}
if ($tools.Count -eq 0) {
  throw "ToolsJson must define at least one Craft function tool."
}
$metadata = @{
  agentId = $AgentId
  agentName = $AgentName.Trim()
  version = $Version.Trim()
  description = $Description.Trim()
  iconUrl = $IconUrl.Trim()
  permissions = ($permissionValues -join ",")
  category = $Category.Trim()
  tools = $tools
}
$metadataJson = $jsonSerializer.Serialize($metadata)

Write-Output "Metadata JSON preview:"
Write-Output $metadataJson

if (-not $Execute) {
  Write-Output ""
  Write-Output "Dry run only. Add -Execute with ROKID_CRAFT_ACCOUNT_TOKEN and either ROKID_CRAFT_AGENT_ID or ROKID_CRAFT_URL to upload."
  exit 0
}

if (-not $AccountToken) {
  throw "ROKID_CRAFT_ACCOUNT_TOKEN or -AccountToken is required for upload."
}
if (-not $AgentId) {
  throw "ROKID_CRAFT_AGENT_ID, -AgentId, ROKID_CRAFT_URL, or -CraftUrl is required for upload."
}

$uploadResult = Invoke-CraftUpload -Url $uploadUrl -Headers $headers -FilePath $resolvedAixPath -MetadataJson $metadataJson
Write-Output ("Upload HTTP status: {0}" -f $uploadResult.StatusCode)
Write-SseSummary -Text $uploadResult.Text
$sseStatus = Get-SseUploadStatus -Text $uploadResult.Text
Write-Output ("Upload stream complete: {0}" -f $sseStatus.Complete)
Write-Output ("Upload stream error: {0}" -f $sseStatus.HasError)
if (-not $uploadResult.IsSuccess -or -not $sseStatus.Complete -or $sseStatus.HasError) {
  Write-Output $uploadResult.Text
  exit 1
}
