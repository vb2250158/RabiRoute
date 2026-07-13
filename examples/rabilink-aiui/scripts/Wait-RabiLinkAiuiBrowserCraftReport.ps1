param(
  [string] $BrowserReportPath = "",
  [int] $TimeoutSeconds = 600,
  [int] $PollSeconds = 2,
  [switch] $AcceptExisting,
  [switch] $SkipGoalEvidence,
  [switch] $RunReadiness
)

$ErrorActionPreference = "Stop"

function Resolve-OptionalPath {
  param([string] $PathValue)
  if (-not $PathValue) { return "" }
  return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($PathValue)
}

function Test-FileStable {
  param(
    [string] $PathValue,
    [int] $DelaySeconds
  )

  if (-not (Test-Path -LiteralPath $PathValue)) { return $false }
  $before = Get-Item -LiteralPath $PathValue
  Start-Sleep -Seconds ([Math]::Max(1, $DelaySeconds))
  if (-not (Test-Path -LiteralPath $PathValue)) { return $false }
  $after = Get-Item -LiteralPath $PathValue
  return $before.Length -eq $after.Length -and $before.LastWriteTimeUtc -eq $after.LastWriteTimeUtc
}

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
if (-not $BrowserReportPath) {
  $BrowserReportPath = Join-Path ([Environment]::GetFolderPath("UserProfile")) "Downloads\rabilink-aiui-craft-upload-report.json"
}
$resolvedBrowserReportPath = Resolve-OptionalPath $BrowserReportPath
$startedAt = (Get-Date).ToUniversalTime()
$deadline = (Get-Date).AddSeconds([Math]::Max(1, $TimeoutSeconds))
$poll = [Math]::Max(1, $PollSeconds)

Write-Output ("Waiting for Craft browser report: {0}" -f $resolvedBrowserReportPath)
Write-Output ("Timeout seconds: {0}" -f $TimeoutSeconds)
if (-not $AcceptExisting) {
  Write-Output ("Only accepting reports written after: {0}" -f $startedAt.ToString("o"))
}

$reportItem = $null
while ((Get-Date) -lt $deadline) {
  if (Test-Path -LiteralPath $resolvedBrowserReportPath) {
    $item = Get-Item -LiteralPath $resolvedBrowserReportPath
    $newEnough = $AcceptExisting -or $item.LastWriteTimeUtc -ge $startedAt.AddSeconds(-2)
    if ($newEnough -and (Test-FileStable -PathValue $resolvedBrowserReportPath -DelaySeconds 1)) {
      $reportItem = Get-Item -LiteralPath $resolvedBrowserReportPath
      break
    }
  }
  Start-Sleep -Seconds $poll
}

if (-not $reportItem) {
  Write-Output "Timed out waiting for a new Craft browser report."
  Write-Output "In Craft DevTools helper, click: Check session -> Upload selected AIX -> List agents -> Download report."
  exit 1
}

Write-Output ("Detected Craft browser report: {0}" -f $reportItem.FullName)
Write-Output ("Report size: {0}" -f $reportItem.Length)
Write-Output ("Report last write: {0}" -f $reportItem.LastWriteTimeUtc.ToString("o"))

$importScript = Join-Path $PSScriptRoot "Import-RabiLinkAiuiBrowserCraftReport.ps1"
& powershell -NoProfile -ExecutionPolicy Bypass -File $importScript -BrowserReportPath $reportItem.FullName
if ($LASTEXITCODE -ne 0) {
  throw "Import-RabiLinkAiuiBrowserCraftReport.ps1 failed."
}

if (-not $SkipGoalEvidence) {
  $goalEvidenceScript = Join-Path $PSScriptRoot "Test-RabiLinkAiuiGoalEvidence.ps1"
  & powershell -NoProfile -ExecutionPolicy Bypass -File $goalEvidenceScript
  if ($LASTEXITCODE -ne 0) {
    throw "Test-RabiLinkAiuiGoalEvidence.ps1 failed."
  }
}

if ($RunReadiness) {
  $readinessScript = Join-Path $PSScriptRoot "Test-RabiLinkAiuiReadiness.ps1"
  & powershell -NoProfile -ExecutionPolicy Bypass -File $readinessScript -RequireCraftUploadStatus
  if ($LASTEXITCODE -ne 0) {
    throw "Test-RabiLinkAiuiReadiness.ps1 failed."
  }
}

Write-Output "Craft browser report imported and evidence refreshed."
