param(
  [string] $AixPath = "",
  [string] $AdbPath = "",
  [string] $DevicePath = "/sdcard/Download/rabilink-aiui.aix"
)

$ErrorActionPreference = "Stop"

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

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$repoRoot = Resolve-Path -LiteralPath (Join-Path $projectRoot "..\..")

if (-not $AixPath) {
  $AixPath = Join-Path $projectRoot "dist\rabilink-aiui.aix"
}
$resolvedAixPath = Resolve-OptionalPath $AixPath

if (-not $AdbPath) {
  $AdbPath = Join-Path $repoRoot "apps\rabilink-android\out\tools\android-sdk\platform-tools\adb.exe"
}
$resolvedAdbPath = Resolve-OptionalPath $AdbPath

if (-not (Test-Path -LiteralPath $resolvedAixPath)) {
  throw "AIX package is missing: $resolvedAixPath"
}
if (-not (Test-Path -LiteralPath $resolvedAdbPath)) {
  throw "ADB executable is missing: $resolvedAdbPath"
}

$localFile = Get-Item -LiteralPath $resolvedAixPath
$localHash = Get-Sha256Hex $resolvedAixPath

Write-Output ("Local AIX: {0}" -f $localFile.FullName)
Write-Output ("Local size: {0}" -f $localFile.Length)
Write-Output ("Local sha256: {0}" -f $localHash)

$devices = & $resolvedAdbPath devices -l
$deviceRows = @($devices | Where-Object { $_ -match "\sdevice\s" })
if ($deviceRows.Count -eq 0) {
  throw "No ADB device is connected."
}
Write-Output "ADB devices:"
$deviceRows | ForEach-Object { Write-Output ("  " + $_) }

& $resolvedAdbPath push $resolvedAixPath $DevicePath
if ($LASTEXITCODE -ne 0) {
  throw "adb push failed."
}

$remoteListing = & $resolvedAdbPath shell ls -l $DevicePath
Write-Output ("Remote file: {0}" -f $remoteListing)

$remoteHashOutput = & $resolvedAdbPath shell sha256sum $DevicePath 2>$null
if ($LASTEXITCODE -eq 0 -and $remoteHashOutput) {
  $remoteHashParts = @($remoteHashOutput -split "\s+")
  $remoteHash = if ($remoteHashParts.Count -gt 0) { $remoteHashParts[0].Trim().ToLowerInvariant() } else { "" }
  Write-Output ("Remote sha256: {0}" -f $remoteHash)
  if ($remoteHash -ne $localHash) {
    throw "Remote package hash does not match local package hash."
  }
  Write-Output "Phone package hash verified."
} else {
  Write-Output "Remote sha256 unavailable; adb push completed and remote listing was printed."
}
