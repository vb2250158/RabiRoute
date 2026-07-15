param(
  [string] $OutputPath = "",
  [string] $RelayBaseUrl = "",
  [string] $VersionId = ""
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
if (-not $OutputPath) {
  $OutputPath = Join-Path $projectRoot "dist\rabilink-aiui.aix"
}

$resolvedOutputDir = Split-Path -Parent $OutputPath
if (-not (Test-Path -LiteralPath $resolvedOutputDir)) {
  New-Item -ItemType Directory -Path $resolvedOutputDir | Out-Null
}
$resolvedOutputPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputPath)

$stagingRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("rabilink-aiui-aix-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $stagingRoot | Out-Null

try {
  $previousRelayEnv = $env:RABILINK_AIUI_RELAY_URL
  if ($RelayBaseUrl) {
    $env:RABILINK_AIUI_RELAY_URL = $RelayBaseUrl
  }
  $buildArgs = @((Join-Path $PSScriptRoot "Build-RabiLinkAiuiPackage.mjs"), "--staging", $stagingRoot)
  if ($VersionId) {
    $buildArgs += @("--version-id", $VersionId)
  }
  & node @buildArgs
  if ($LASTEXITCODE -ne 0) {
    throw "Build-RabiLinkAiuiPackage.mjs failed."
  }

  if (Test-Path -LiteralPath $resolvedOutputPath) {
    Remove-Item -LiteralPath $resolvedOutputPath -Force
  }

  $zipPath = [System.IO.Path]::ChangeExtension($resolvedOutputPath, ".zip")
  if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
  }
  node (Join-Path $PSScriptRoot "Write-DeterministicZip.mjs") $stagingRoot $zipPath
  Move-Item -LiteralPath $zipPath -Destination $resolvedOutputPath -Force
  $info = Get-Item -LiteralPath $resolvedOutputPath
  Write-Output ("Packaged {0} ({1} bytes)" -f $info.FullName, $info.Length)
}
finally {
  if ($RelayBaseUrl) {
    if ($null -eq $previousRelayEnv) {
      Remove-Item Env:RABILINK_AIUI_RELAY_URL -ErrorAction SilentlyContinue
    } else {
      $env:RABILINK_AIUI_RELAY_URL = $previousRelayEnv
    }
  }
  if (Test-Path -LiteralPath $stagingRoot) {
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force
  }
}
