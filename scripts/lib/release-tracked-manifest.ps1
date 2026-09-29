# Explicit snapshots only; this helper does not enumerate untracked files.
function Read-ReleaseTrackedManifest([string]$ManifestPath, [string]$SourceRoot) {
    $manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.version -ne 1 -or $null -eq $manifest.files -or $manifest.files -isnot [array] -or $manifest.files.Count -eq 0) { throw 'Invalid tracked manifest contract' }
    $root = [IO.Path]::GetFullPath($SourceRoot).TrimEnd('\', '/')
    if ((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Source root is a reparse point' }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $result = @()
    foreach ($entry in $manifest.files) {
        $relative = [string]$entry.path
        if ($relative -notmatch '^(assets|docs|skills|examples/data|apps/rabi-agent|plugin-adapters|plugins/contracts/plugin-sdk|scripts)/' -or $relative -match '[\\:\x00-\x1f\x7f]' -or $relative -match '(^|/)\.env[^/]*($|/)' -or ($relative -match '(^|/)data(/|$)' -and !$relative.StartsWith('examples/data/')) -or $relative -match '(^|/)(\.|\.\.|\.git|node_modules|logs|recordings|transcripts|\.env)(/|$)' -or $relative -match '(^|/)[^/]+[. ](/|$)' -or $relative.Contains('//') -or !$seen.Add($relative)) { throw 'Unsafe or duplicate tracked path' }
        if ([string]$entry.sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid tracked hash' }
        $cursor = $root
        foreach ($segment in $relative.Split('/')) {
            $cursor = Join-Path $cursor $segment
            if (!(Test-Path -LiteralPath $cursor)) { throw "Missing tracked file: $relative" }
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Tracked path contains a reparse point' }
        }
        if (!(Test-Path -LiteralPath $cursor -PathType Leaf)) { throw 'Tracked entry is not a file' }
        if ((Get-FileHash -LiteralPath $cursor -Algorithm SHA256).Hash -ne $entry.sha256) { throw "Tracked hash mismatch: $relative" }
        $result += [pscustomobject]@{ path = $relative; sha256 = [string]$entry.sha256 }
    }
    return ,$result
}
