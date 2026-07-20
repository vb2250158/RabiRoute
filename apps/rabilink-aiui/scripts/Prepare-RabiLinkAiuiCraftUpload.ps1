param(
  [string] $OutputDir = "",
  [string] $RelayBaseUrl = "",
  [string] $VersionId = ""
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
if (-not $RelayBaseUrl) {
  $relayConfigPath = Join-Path $projectRoot "..\..\data\rabilink-relay\config.json"
  if (Test-Path -LiteralPath $relayConfigPath) {
    $relayConfig = Get-Content -LiteralPath $relayConfigPath -Raw | ConvertFrom-Json
    $RelayBaseUrl = [string]$relayConfig.publicBaseUrl
  }
}
if (-not $RelayBaseUrl) {
  throw "RelayBaseUrl is required. Pass -RelayBaseUrl or configure data\rabilink-relay\config.json publicBaseUrl."
}
if (-not $OutputDir) {
  $OutputDir = Join-Path $projectRoot "dist\craft-upload"
}
$resolvedOutputDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDir)
$previousRelayEnv = $env:RABILINK_AIUI_RELAY_URL

try {
  if ($RelayBaseUrl) {
    $env:RABILINK_AIUI_RELAY_URL = $RelayBaseUrl
  }

  $buildArgs = @((Join-Path $PSScriptRoot "Build-RabiLinkAiuiPackage.mjs"), "--staging", $resolvedOutputDir)
  if ($VersionId) {
    $buildArgs += @("--version-id", $VersionId)
  }
  & node @buildArgs
  if ($LASTEXITCODE -ne 0) {
    throw "Build-RabiLinkAiuiPackage.mjs failed."
  }
}
finally {
  if ($null -eq $previousRelayEnv) {
    Remove-Item Env:RABILINK_AIUI_RELAY_URL -ErrorAction SilentlyContinue
  } else {
    $env:RABILINK_AIUI_RELAY_URL = $previousRelayEnv
  }
}

foreach ($relative in @(".aixignore", "AGENTS.md", "README.md")) {
  Copy-Item -LiteralPath (Join-Path $projectRoot $relative) -Destination (Join-Path $resolvedOutputDir $relative) -Force
}

$requiredFiles = @(
  "app.js",
  "app.json",
  "pages\home\index.js",
  "pages\home\index.json",
  "pages\home\index.wxml",
  "pages\home\index.wxss",
  "VERSION"
)
foreach ($relative in $requiredFiles) {
  if (-not (Test-Path -LiteralPath (Join-Path $resolvedOutputDir $relative))) {
    throw "Craft upload staging is missing $relative"
  }
}

foreach ($sourceOnly in @("pages\home\index.ink", "utils", "scripts", "dist", "node_modules", "package.json", "package-lock.json")) {
  if (Test-Path -LiteralPath (Join-Path $resolvedOutputDir $sourceOnly)) {
    throw "Craft upload staging should not contain $sourceOnly"
  }
}

$pageScript = Get-Content -LiteralPath (Join-Path $resolvedOutputDir "pages\home\index.js") -Raw -Encoding UTF8
if ($pageScript -match 'from\s+["'']\.\.?/') {
  throw "Craft page bundle still contains a relative module import."
}

$text = Get-ChildItem -LiteralPath $resolvedOutputDir -Recurse -File |
  Where-Object { $_.Extension -in @(".js", ".json", ".wxml", ".wxss", ".md", "") } |
  ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8 -ErrorAction SilentlyContinue }
$tokenPattern = "rbl_[A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9_-]{20,}"
if (($text -join "`n") -match $tokenPattern) {
  throw "Craft upload staging appears to contain a real token-like secret."
}

$files = Get-ChildItem -LiteralPath $resolvedOutputDir -Recurse -File
Write-Output ("Prepared self-contained Craft import folder: {0}" -f $resolvedOutputDir)
Write-Output ("Files: {0}" -f $files.Count)
