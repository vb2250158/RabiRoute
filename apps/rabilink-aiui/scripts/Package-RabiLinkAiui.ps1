param(
  [string] $OutputPath = "",
  [string] $RelayBaseUrl = "",
  [string] $VersionId = ""
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
# Basic host conversation needs no PC relay. Embed a deployment endpoint only
# through the explicit argument or the builder's existing environment setting.
if (-not $OutputPath) {
  $OutputPath = Join-Path $projectRoot "dist\rabilink-aiui.aix"
}

$resolvedOutputPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputPath)
$resolvedOutputDir = Split-Path -Parent $resolvedOutputPath
if (-not (Test-Path -LiteralPath $resolvedOutputDir)) {
  New-Item -ItemType Directory -Path $resolvedOutputDir | Out-Null
}
$defaultOutputPath = [System.IO.Path]::GetFullPath((Join-Path $projectRoot "dist\rabilink-aiui.aix"))
$keepStaging = $resolvedOutputPath.Equals($defaultOutputPath, [System.StringComparison]::OrdinalIgnoreCase)
$stagingRoot = if ($keepStaging) {
  [System.IO.Path]::GetFullPath((Join-Path $projectRoot "dist\craft-upload"))
} else {
  Join-Path ([System.IO.Path]::GetTempPath()) ("rabilink-aiui-aix-" + [System.Guid]::NewGuid().ToString("N"))
}
# The builder recursively replaces this directory. Verify the default target
# and reject junctions before allowing it to modify an existing staging tree.
if ($keepStaging -and $stagingRoot -ne (Join-Path (Split-Path -Parent $defaultOutputPath) "craft-upload")) {
  throw "Unexpected default staging directory."
}
if ((Test-Path -LiteralPath $stagingRoot) -and
    ((Get-Item -LiteralPath $stagingRoot -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
  throw "Refusing to replace a staging junction or symbolic link."
}
if (-not (Test-Path -LiteralPath $stagingRoot)) {
  New-Item -ItemType Directory -Path $stagingRoot | Out-Null
}

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

  $zipPath = [System.IO.Path]::ChangeExtension($resolvedOutputPath, ".zip")
  if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
  }
  node (Join-Path $PSScriptRoot "Write-DeterministicZip.mjs") $stagingRoot $zipPath
  if ($LASTEXITCODE -ne 0) { throw "Write-DeterministicZip.mjs failed; original AIX retained." }
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
  if (-not $keepStaging -and (Test-Path -LiteralPath $stagingRoot)) {
    $resolvedStagingRoot = [System.IO.Path]::GetFullPath($stagingRoot)
    $resolvedTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolvedStagingRoot.StartsWith($resolvedTempRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not ([System.IO.Path]::GetFileName($resolvedStagingRoot) -match '^rabilink-aiui-aix-[0-9a-f]{32}$')) {
      throw "Refusing to remove an unexpected package staging directory."
    }
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force
  }
}
