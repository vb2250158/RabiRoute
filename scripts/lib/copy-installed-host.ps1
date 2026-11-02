function Assert-HostSnapshotPath([string]$PathValue) {
    $full = [IO.Path]::GetFullPath($PathValue)
    $root = [IO.Path]::GetPathRoot($full)
    $cursor = $root
    foreach ($part in $full.Substring($root.Length).Split([IO.Path]::DirectorySeparatorChar, [StringSplitOptions]::RemoveEmptyEntries)) {
        $cursor = Join-Path $cursor $part
        if (!(Test-Path -LiteralPath $cursor)) { throw 'Installed Host snapshot path is missing' }
        if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installed Host snapshot path contains a reparse point' }
    }
    return $full
}

# The installed release manifest records hashes for the two versioned Core files.
# Bootstrap is outside that manifest: its independently supplied hash is a
# change fence, not a signature or an independent proof of its origin.
function Copy-InstalledHostSnapshot([string]$InstallRoot, [string]$Destination, [string]$ExpectedBootstrapSha256) {
    if ($ExpectedBootstrapSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid expected bootstrap hash' }
    $source = (Assert-HostSnapshotPath $InstallRoot).TrimEnd('\', '/')
    $target = [IO.Path]::GetFullPath($Destination).TrimEnd('\', '/')
    if ($target -eq $source -or $target.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase) -or $source.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Host snapshot source and destination overlap' }
    if (Test-Path -LiteralPath $target) { throw 'Host snapshot destination already exists' }
    $null = Assert-HostSnapshotPath (Split-Path -Parent $target)
    $pointer = Assert-HostSnapshotPath (Join-Path $source 'current.json')
    $pointerHash = (Get-FileHash -LiteralPath $pointer -Algorithm SHA256).Hash
    $current = Get-Content -LiteralPath $pointer -Raw -Encoding UTF8 | ConvertFrom-Json
    $id = [string]$current.releaseId
    if ($current.schemaVersion -ne 1 -or $current.appId -ne 'io.rabiroute.windows' -or $id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' -or $id.Contains('..') -or $current.versionPath -cne "versions/$id" -or $current.payloadSha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid installed Host pointer' }
    $version = Assert-HostSnapshotPath (Join-Path $source ("versions\" + $id))
    $manifestPath = Assert-HostSnapshotPath (Join-Path $version 'release-manifest.json')
    $manifestHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or $manifest.appId -ne 'io.rabiroute.windows' -or $manifest.releaseId -cne $id -or $manifest.payloadSha256 -cne $current.payloadSha256 -or $manifest.files -isnot [array] -or !$manifest.files.Count) { throw 'Installed release manifest does not match its pointer' }
    $canonical = [Text.StringBuilder]::new()
    foreach ($entry in $manifest.files) {
        if ($entry.path -isnot [string] -or $entry.sha256 -notmatch '^[a-f0-9]{64}$' -or $entry.size -isnot [ValueType] -or [long]$entry.size -lt 0) { throw 'Invalid installed release manifest entry' }
        $null = $canonical.Append([string]$entry.path).Append([char]0).Append(([long]$entry.size).ToString([Globalization.CultureInfo]::InvariantCulture)).Append([char]0).Append([string]$entry.sha256).Append("`n")
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $actual = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonical.ToString()))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
    if ($actual -cne $current.payloadSha256) { throw 'Installed release manifest digest is invalid' }
    $bootstrap = Assert-HostSnapshotPath (Join-Path $source 'RabiRouteHost.exe')
    if ((Get-FileHash -LiteralPath $bootstrap -Algorithm SHA256).Hash -ne $ExpectedBootstrapSha256) { throw 'Installed bootstrap hash changed' }
    $coreFiles = @('RabiRouteHost.Core.dll', 'RabiRouteHost.Core.deps.json')
    $inputs = @()
    foreach ($name in $coreFiles) {
        $entries = @($manifest.files | Where-Object { $_.path -ceq $name })
        if ($entries.Count -ne 1) { throw 'Installed Host Core entry is missing or ambiguous' }
        $file = Assert-HostSnapshotPath (Join-Path $version $name)
        if ((Get-Item -LiteralPath $file).Length -ne [long]$entries[0].size -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $entries[0].sha256) { throw 'Installed Host Core hash mismatch' }
        $inputs += [pscustomobject]@{ source = $file; name = $name; hash = [string]$entries[0].sha256 }
    }
    [IO.Directory]::CreateDirectory((Join-Path $target 'version')) | Out-Null
    Copy-Item -LiteralPath $bootstrap -Destination (Join-Path $target 'RabiRouteHost.exe')
    if ((Get-FileHash -LiteralPath (Join-Path $target 'RabiRouteHost.exe')).Hash -ne $ExpectedBootstrapSha256) { throw 'Copied bootstrap hash mismatch' }
    foreach ($inputFile in $inputs) {
        $copy = Join-Path (Join-Path $target 'version') $inputFile.name
        Copy-Item -LiteralPath $inputFile.source -Destination $copy
        if ((Get-FileHash -LiteralPath $copy).Hash -ne $inputFile.hash) { throw 'Copied Host Core hash mismatch' }
    }
    if ((Get-FileHash -LiteralPath $pointer).Hash -ne $pointerHash -or (Get-FileHash -LiteralPath $manifestPath).Hash -ne $manifestHash) { throw 'Installed Host identity changed during snapshot' }
}
