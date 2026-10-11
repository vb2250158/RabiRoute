function Reset-ReleasePayloadOutput([string]$OutputRoot, [string[]]$ProtectedRoots, [string]$Version) {
    $root = [IO.Path]::GetFullPath($OutputRoot).TrimEnd('\', '/')
    if ($Version -notmatch '^[a-zA-Z0-9._-]+$') { throw 'Unsafe release version' }
    $prefix = $root + [IO.Path]::DirectorySeparatorChar
    $targets = @('version-payload', 'distribution', "RabiRoute-$Version-windows-x64-portable.zip", "RabiRoute-$Version-windows-x64-setup.exe", 'SHA256SUMS.txt')
    $existing = @()
    foreach ($leaf in $targets) {
        $target = [IO.Path]::GetFullPath((Join-Path $root $leaf))
        if (!$target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Release target escaped output root' }
        foreach ($protected in $ProtectedRoots) {
            $source = [IO.Path]::GetFullPath($protected).TrimEnd('\', '/')
            if ($source -eq $target -or $source.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase) -or $target.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Release payload overlaps a runtime source'
            }
        }
        if (Test-Path -LiteralPath $target) { $existing += [pscustomobject]@{ leaf=$leaf; path=$target } }
    }
    if (!$existing.Count) { return }
    $backup = [IO.Path]::GetFullPath((Join-Path $root ('build-backups\' + [guid]::NewGuid().ToString('N'))))
    if (!$backup.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Backup escaped output root' }
    $hashes = @()
    foreach ($entry in $existing) {
        $pending = [Collections.Generic.Queue[string]]::new(); $pending.Enqueue($entry.path)
        while ($pending.Count) {
            $candidate = $pending.Dequeue(); $item = Get-Item -LiteralPath $candidate -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Release backup refuses reparse points' }
            if ($item.PSIsContainer) {
                foreach ($child in Get-ChildItem -LiteralPath $candidate -Force) { $pending.Enqueue($child.FullName) }
            } else {
                $relative = $candidate.Substring($root.Length + 1)
                $hashes += [pscustomobject]@{ path=$relative; sha256=(Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash }
            }
        }
    }
    New-Item -ItemType Directory -Force -Path $backup | Out-Null
    foreach ($entry in $existing) { Copy-Item -LiteralPath $entry.path -Destination (Join-Path $backup $entry.leaf) -Recurse -Force }
    foreach ($file in $hashes) {
        if ((Get-FileHash -LiteralPath (Join-Path $backup $file.path) -Algorithm SHA256).Hash -cne $file.sha256) { throw 'Release backup readback failed' }
    }
    $hashes | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $backup 'source-hashes.json') -Encoding UTF8
    foreach ($file in $hashes) {
        if ((Get-FileHash -LiteralPath (Join-Path $root $file.path) -Algorithm SHA256).Hash -cne $file.sha256) { throw 'Release output changed during backup' }
    }
    foreach ($entry in $existing) {
        if (!$entry.path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Release cleanup escaped output root' }
        Remove-Item -LiteralPath $entry.path -Recurse -Force
    }
    Write-Host "[windows-release] Prior payload artifacts backed up with verified hashes: $backup"
}
