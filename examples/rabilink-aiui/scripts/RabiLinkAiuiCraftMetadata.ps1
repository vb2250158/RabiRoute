function Read-RabiLinkAiuiAixPageDefinition {
  param(
    [Parameter(Mandatory = $true)]
    [string] $AixPath,
    [string] $EntryPath = "pages/home/index.json"
  )

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::OpenRead($AixPath)
  try {
    $normalizedEntryPath = $EntryPath.Replace("\", "/")
    $entry = $archive.Entries | Where-Object {
      $_.FullName.Replace("\", "/") -eq $normalizedEntryPath
    } | Select-Object -First 1
    if (-not $entry) {
      throw "AIX page definition is missing: $normalizedEntryPath"
    }

    $stream = $entry.Open()
    $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::UTF8, $true)
    try {
      $definition = $reader.ReadToEnd() | ConvertFrom-Json
    }
    finally {
      $reader.Dispose()
      $stream.Dispose()
    }

    if ([string]::IsNullOrWhiteSpace([string]$definition.description)) {
      throw "AIX page definition has no description: $normalizedEntryPath"
    }
    if (-not $definition.schema -or -not $definition.schema.data) {
      throw "AIX page definition has no schema.data: $normalizedEntryPath"
    }
    return $definition
  }
  finally {
    $archive.Dispose()
  }
}

function Read-RabiLinkAiuiCraftRelease {
  param(
    [Parameter(Mandatory = $true)]
    [string] $ProjectRoot
  )

  $releasePath = Join-Path $ProjectRoot "craft-release.json"
  if (-not (Test-Path -LiteralPath $releasePath)) {
    throw "Craft release metadata is missing: $releasePath"
  }
  $release = Get-Content -LiteralPath $releasePath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([string]::IsNullOrWhiteSpace([string]$release.agentName)) {
    throw "craft-release.json must define agentName."
  }
  if ([string]::IsNullOrWhiteSpace([string]$release.version)) {
    throw "craft-release.json must define version."
  }
  return $release
}

function Resolve-RabiLinkAiuiDefaultAixPath {
  param(
    [Parameter(Mandatory = $true)]
    [string] $ProjectRoot
  )

  $candidates = @(
    (Join-Path $ProjectRoot "dist\rabilink-aiui.aix"),
    (Join-Path $ProjectRoot "rabilink-aiui.aix")
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  return $candidates[0]
}

function Get-RabiLinkAiuiCraftToolsJson {
  param(
    [Parameter(Mandatory = $true)]
    [string] $AixPath,
    [int] $Width = 448,
    [int] $Height = 150
  )

  $definition = Read-RabiLinkAiuiAixPageDefinition -AixPath $AixPath
  $tool = [ordered]@{
    type = "function"
    target = "_current"
    layout = [ordered]@{
      width = $Width
      height = $Height
    }
    function = [ordered]@{
      name = "index"
      description = [string]$definition.description
      parameters = $definition.schema.data
    }
  }
  return ConvertTo-Json -InputObject @($tool) -Depth 40 -Compress
}
