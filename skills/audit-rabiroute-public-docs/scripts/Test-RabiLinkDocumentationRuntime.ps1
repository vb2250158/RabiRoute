[CmdletBinding()]
param(
  [string]$ProjectRoot = "",
  [string]$ConfigPath = "",
  [string]$Username = "Administrator",
  [string]$RemoteRoot = "C:\opt\rabilink-relay",
  [switch]$Json
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\.."))
} else {
  $ProjectRoot = [IO.Path]::GetFullPath($ProjectRoot)
}
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = Join-Path $ProjectRoot "data\rabilink-relay\config.json"
}
if (-not (Test-Path -LiteralPath $ConfigPath)) {
  throw "Relay deployment config is missing. Pass -ConfigPath or create the ignored local config."
}

$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$serverIp = [string]$config.serverIp
$keyPath = [string]$config.sshKeyPath
$domain = if ($config.publicHost) {
  [string]$config.publicHost
} elseif ($config.publicBaseUrl) {
  ([Uri][string]$config.publicBaseUrl).Host
} else {
  ""
}
if ([string]::IsNullOrWhiteSpace($serverIp) -or [string]::IsNullOrWhiteSpace($domain)) {
  throw "Relay deployment config is missing serverIp or publicHost/publicBaseUrl."
}
if ([string]::IsNullOrWhiteSpace($keyPath) -or -not (Test-Path -LiteralPath $keyPath)) {
  throw "Configured SSH key is unavailable."
}

$localRelayPath = Join-Path $ProjectRoot "scripts\rabilink-relay-server.mjs"
$localWebguiRoot = Join-Path $ProjectRoot "ribiwebgui\dist"
$localReportPath = Join-Path $localWebguiRoot "reports\rabispeech-model-benchmark.html"
$localGuidePath = Join-Path $ProjectRoot "docs\user-guide\speech-api.md"
$localGuideEnglishPath = Join-Path $ProjectRoot "docs\user-guide\speech-api_en.md"
$localOpenApiPath = Join-Path $ProjectRoot "examples\rabilink-relay\rabilink-speech-api.openapi.json"
$localAsset = Get-ChildItem -LiteralPath (Join-Path $localWebguiRoot "assets") -Filter "index-*.js" -File -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
$localAssetText = if ($localAsset) { Get-Content -LiteralPath $localAsset.FullName -Raw -Encoding UTF8 } else { "" }
$localRelayText = if (Test-Path -LiteralPath $localRelayPath) { Get-Content -LiteralPath $localRelayPath -Raw -Encoding UTF8 } else { "" }
$localOpenApiText = if (Test-Path -LiteralPath $localOpenApiPath) { Get-Content -LiteralPath $localOpenApiPath -Raw -Encoding UTF8 } else { "" }
$localChecks = [ordered]@{
  RelayScript = Test-Path -LiteralPath $localRelayPath
  ReportsRoute = $localRelayText.Contains('match.restPath.startsWith("/reports/")')
  WebguiIndex = Test-Path -LiteralPath (Join-Path $localWebguiRoot "index.html")
  RemoteSpeechGuideInBuild = $localAssetText.Contains("speech-api.md") -and $localAssetText.Contains("/api/rabilink/speech/v1/audio/speech")
  RelativeReportLinkInBuild = $localAssetText.Contains("reports/rabispeech-model-benchmark.html")
  Report = Test-Path -LiteralPath $localReportPath
  ChineseGuide = Test-Path -LiteralPath $localGuidePath
  EnglishGuide = Test-Path -LiteralPath $localGuideEnglishPath
  SpeechOpenApi = $localOpenApiText.Contains('"/v1/audio/speech"') -and $localOpenApiText.Contains('"/v1/audio/transcriptions"')
}
$localReady = @($localChecks.Values) -notcontains $false
if (-not $localChecks.RelayScript) {
  throw "Local Relay server script is missing."
}
$localRelayHash = (Get-FileHash -LiteralPath $localRelayPath -Algorithm SHA256).Hash

$remoteTemplate = @'
$ProgressPreference = 'SilentlyContinue'
function Get-TaskInfo([string]$name, [string]$expectedScript) {
  $raw = & schtasks.exe /Query /TN $name /XML 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $raw) {
    return [pscustomobject]@{ Exists=$false; Enabled=$false; ActionMatches=$false }
  }
  [xml]$xml = ($raw -join [Environment]::NewLine)
  $ns = New-Object Xml.XmlNamespaceManager($xml.NameTable)
  $ns.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
  $enabled = $xml.SelectSingleNode('//t:Settings/t:Enabled',$ns)
  $arguments = $xml.SelectSingleNode('//t:Actions/t:Exec/t:Arguments',$ns)
  [pscustomobject]@{
    Exists = $true
    Enabled = if ($enabled) { [bool]::Parse($enabled.InnerText) } else { $true }
    ActionMatches = if ($arguments) { $arguments.InnerText -like "*$expectedScript*" } else { $false }
  }
}
$remoteRoot = '__REMOTE_ROOT__'
$relayPath = Join-Path $remoteRoot 'rabilink-relay-server.mjs'
$webguiRoot = Join-Path $remoteRoot 'ribiwebgui\dist'
$asset = Get-ChildItem -LiteralPath (Join-Path $webguiRoot 'assets') -Filter 'index-*.js' -File -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
$assetText = if ($asset) { Get-Content -LiteralPath $asset.FullName -Raw -Encoding UTF8 } else { '' }
$reportPath = Join-Path $webguiRoot 'reports\rabispeech-model-benchmark.html'
$relayTask = Get-TaskInfo '\RabiLinkRelay' 'start-rabilink-relay.ps1'
$caddyTask = Get-TaskInfo '\RabiLinkCaddy' 'start-caddy.ps1'
$relayProcesses = @(Get-CimInstance Win32_Process -Filter "name = 'node.exe'" | Where-Object { $_.CommandLine -like '*rabilink-relay-server.mjs*' })
$caddyProcesses = @(Get-CimInstance Win32_Process -Filter "name = 'caddy.exe'")
[pscustomobject]@{
  RelayScriptExists = Test-Path -LiteralPath $relayPath
  RelayScriptHash = if (Test-Path -LiteralPath $relayPath) { (Get-FileHash -LiteralPath $relayPath -Algorithm SHA256).Hash } else { '' }
  HasReportsRoute = if (Test-Path -LiteralPath $relayPath) { [bool](Select-String -LiteralPath $relayPath -Pattern 'match.restPath.startsWith("/reports/")' -SimpleMatch -Quiet) } else { $false }
  WebguiIndexExists = Test-Path -LiteralPath (Join-Path $webguiRoot 'index.html')
  HasRemoteSpeechGuide = $assetText.Contains('speech-api.md') -and $assetText.Contains('/api/rabilink/speech/v1/audio/speech')
  HasRelativeReportLink = $assetText.Contains('reports/rabispeech-model-benchmark.html')
  ReportExists = Test-Path -LiteralPath $reportPath
  ReportBytes = if (Test-Path -LiteralPath $reportPath) { (Get-Item -LiteralPath $reportPath).Length } else { 0 }
  RelayTask = $relayTask
  CaddyTask = $caddyTask
  RelayProcessCount = $relayProcesses.Count
  CaddyProcessCount = $caddyProcesses.Count
  BackupCount = @(Get-ChildItem -LiteralPath (Join-Path $remoteRoot 'backups') -Directory -ErrorAction SilentlyContinue).Count
} | ConvertTo-Json -Depth 6 -Compress
'@
$escapedRemoteRoot = $RemoteRoot.Replace("'", "''")
$remoteScript = $remoteTemplate.Replace("__REMOTE_ROOT__", $escapedRemoteRoot)
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($remoteScript))
$rawRemote = $null
$sshExitCode = 255
for ($attempt = 1; $attempt -le 3; $attempt += 1) {
  $rawRemote = & ssh -i $keyPath -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=8 "$Username@$serverIp" "powershell -NoProfile -EncodedCommand $encoded"
  $sshExitCode = $LASTEXITCODE
  if ($sshExitCode -eq 0) { break }
  if ($attempt -lt 3) { Start-Sleep -Seconds $attempt }
}
if ($sshExitCode -ne 0) {
  throw "Read-only Relay SSH check failed with exit code $sshExitCode after 3 attempts. The script did not change remote state."
}
$remote = $rawRemote | ConvertFrom-Json
$publicHealth = Invoke-RestMethod -Uri "https://$domain/health" -TimeoutSec 15
$supervisorReady = [bool]$remote.RelayTask.Exists -and [bool]$remote.RelayTask.Enabled -and [bool]$remote.RelayTask.ActionMatches -and
  [bool]$remote.CaddyTask.Exists -and [bool]$remote.CaddyTask.Enabled -and [bool]$remote.CaddyTask.ActionMatches -and
  [int]$remote.RelayProcessCount -gt 0 -and [int]$remote.CaddyProcessCount -gt 0
$deploymentNeeded = $remote.RelayScriptHash -ne $localRelayHash -or -not [bool]$remote.HasReportsRoute -or -not [bool]$remote.HasRemoteSpeechGuide
$readyToDeploy = $localReady -and [bool]$publicHealth.ok -and $supervisorReady

$result = [ordered]@{
  ReadOnly = $true
  LocalReady = $localReady
  LocalChecks = $localChecks
  PublicHealthOk = [bool]$publicHealth.ok
  SupervisorReady = $supervisorReady
  DeploymentNeeded = $deploymentNeeded
  ReadyToDeploy = $readyToDeploy
  Remote = [ordered]@{
    RelayCodeMatchesLocal = $remote.RelayScriptHash -eq $localRelayHash
    ReportsRoute = [bool]$remote.HasReportsRoute
    RemoteSpeechGuideInBuild = [bool]$remote.HasRemoteSpeechGuide
    RelativeReportLinkInBuild = [bool]$remote.HasRelativeReportLink
    Report = [bool]$remote.ReportExists
    ReportBytes = [int64]$remote.ReportBytes
    RelayTaskReady = [bool]$remote.RelayTask.Exists -and [bool]$remote.RelayTask.Enabled -and [bool]$remote.RelayTask.ActionMatches
    CaddyTaskReady = [bool]$remote.CaddyTask.Exists -and [bool]$remote.CaddyTask.Enabled -and [bool]$remote.CaddyTask.ActionMatches
    RelayProcessCount = [int]$remote.RelayProcessCount
    CaddyProcessCount = [int]$remote.CaddyProcessCount
    RollbackSnapshots = [int]$remote.BackupCount
  }
}

if ($Json) {
  $result | ConvertTo-Json -Depth 8
} else {
  [pscustomobject]@{
    ReadOnly = $result.ReadOnly
    LocalReady = $result.LocalReady
    PublicHealthOk = $result.PublicHealthOk
    SupervisorReady = $result.SupervisorReady
    DeploymentNeeded = $result.DeploymentNeeded
    ReadyToDeploy = $result.ReadyToDeploy
    RemoteReportsRoute = $result.Remote.ReportsRoute
    RemoteSpeechGuide = $result.Remote.RemoteSpeechGuideInBuild
    RollbackSnapshots = $result.Remote.RollbackSnapshots
  } | Format-List
}

if (-not $readyToDeploy) {
  exit 1
}
