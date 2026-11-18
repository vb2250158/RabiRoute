function Test-BuildPathWithin([string]$PathValue, [string]$Root) {
    return $PathValue.Equals($Root, [StringComparison]::OrdinalIgnoreCase) -or
        $PathValue.StartsWith($Root.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-BuildPathWithoutReparse([string]$PathValue, [switch]$Recurse) {
    $cursor = [IO.Path]::GetFullPath($PathValue)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Refusing a build output with a reparse point ancestor: $cursor"
            }
        }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
    if ($Recurse -and (Test-Path -LiteralPath $PathValue -PathType Container)) {
        $pending = [Collections.Generic.Queue[string]]::new()
        $pending.Enqueue($PathValue)
        while ($pending.Count) {
            foreach ($child in Get-ChildItem -LiteralPath $pending.Dequeue() -Force) {
                if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                    throw "Refusing a build output containing a reparse point: $($child.FullName)"
                }
                if ($child.PSIsContainer) {
                    if ((Test-Path -LiteralPath (Join-Path $child.FullName 'current.json') -PathType Leaf) -and
                        (Test-Path -LiteralPath (Join-Path $child.FullName 'RabiRouteHost.exe') -PathType Leaf)) {
                        throw "Refusing a build output containing an installed application: $($child.FullName)"
                    }
                    $pending.Enqueue($child.FullName)
                }
            }
        }
    }
}

function Assert-BuildOutputBoundary {
    param(
        [Parameter(Mandatory)][string]$OutputRoot,
        [Parameter(Mandatory)][string]$RepositoryRoot,
        [string[]]$InputPaths = @(),
        [string[]]$OwnedLeaves
    )
    $output = [IO.Path]::GetFullPath($OutputRoot).TrimEnd('\', '/')
    $repository = [IO.Path]::GetFullPath($RepositoryRoot).TrimEnd('\', '/')
    if (-not $output -or $output -eq [IO.Path]::GetPathRoot($output).TrimEnd('\', '/') -or
        (Test-BuildPathWithin $repository $output)) {
        throw "Refusing a build output that contains the repository or a filesystem root: $output"
    }
    Assert-BuildPathWithoutReparse $output

    $installation = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\RabiRoute')).TrimEnd('\', '/')
    $cursor = $output
    while ($cursor) {
        if ((Test-Path -LiteralPath (Join-Path $cursor 'current.json') -PathType Leaf) -and
            (Test-Path -LiteralPath (Join-Path $cursor 'RabiRouteHost.exe') -PathType Leaf)) {
            throw "Refusing a build output inside an installed application: $cursor"
        }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
    if ((Test-BuildPathWithin $output $installation) -or (Test-BuildPathWithin $installation $output)) {
        throw "Refusing a build output overlapping the installed application: $output"
    }

    # These are build inputs, not an allowlist of output locations. Private
    # candidates under other repository directories remain valid outputs.
    $inputs = @($InputPaths) + @('src', 'desktop', 'scripts', 'dist', 'ribiwebgui', 'plugins', 'packages',
        'assets', 'docs', 'skills', 'examples', 'apps', 'installer', 'node_modules', 'source-patches',
        '.git', 'package.json', 'package-lock.json', '.env' | ForEach-Object { Join-Path $repository $_ })
    $targets = if ($OwnedLeaves) { @($OwnedLeaves | ForEach-Object { Join-Path $output $_ }) } else { @($output) }
    foreach ($target in $targets) {
        $target = [IO.Path]::GetFullPath($target).TrimEnd('\', '/')
        if (-not (Test-BuildPathWithin $target $output)) { throw 'Refusing a build output target outside its owner' }
        Assert-BuildPathWithoutReparse $target -Recurse
        foreach ($inputPath in $inputs) {
            if (-not $inputPath) { continue }
            $inputRoot = [IO.Path]::GetFullPath($inputPath).TrimEnd('\', '/')
            if ((Test-BuildPathWithin $inputRoot $target) -or (Test-BuildPathWithin $target $inputRoot)) {
                throw "Refusing a build output overlapping an input: $target ($inputRoot)"
            }
        }
    }
    return $output
}
