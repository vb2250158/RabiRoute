function Read-ComputerTrackingAssetSpec([string]$AgentRoot) {
    $spec = Get-Content -LiteralPath (Join-Path $AgentRoot 'desktop/tracking/asset-spec.json') -Raw | ConvertFrom-Json
    if ($spec.schemaVersion -ne 1 -or $spec.architecture -ne 'win-x64') { throw 'Unsupported computer tracking asset specification.' }
    return $spec
}
function Get-ComputerTrackingFileNames($spec) {
    return @($spec.managedFiles) + @($spec.nativeFiles | ForEach-Object { $_.path }) + @($spec.notices | ForEach-Object { $_.path })
}
function Assert-ComputerTrackingManifest($manifest, $spec) {
    if ($manifest.schemaVersion -ne $spec.schemaVersion -or $manifest.architecture -ne $spec.architecture) { throw 'Unsupported computer tracking asset manifest.' }
    foreach ($pair in @(@{ actual=@($manifest.inputs | ForEach-Object { $_.path }); expected=@($spec.inputs) }, @{ actual=@($manifest.files | ForEach-Object { $_.path }); expected=@(Get-ComputerTrackingFileNames $spec) })) {
        if ($pair.actual.Count -ne $pair.expected.Count -or @($pair.actual | Select-Object -Unique).Count -ne $pair.expected.Count -or @(Compare-Object $pair.actual $pair.expected).Count -ne 0) { throw 'Computer tracking asset closure is incomplete or duplicated.' }
    }
}
function Build-ComputerTrackingAssets([string]$AgentRoot, [string]$Stage) {
    $spec = Read-ComputerTrackingAssetSpec $AgentRoot
    $project = Join-Path $AgentRoot 'desktop/tracking/RabiAgent.Computer.Tracking.csproj'
    $locked = Join-Path $AgentRoot 'desktop/tracking/packages.lock.json'
    foreach ($file in @($project,$locked)) { if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Computer tracking build input missing: $file" } }
    $work = Join-Path $Stage '.tracking-build'
    $obj = Join-Path $work 'obj/'
    $out = Join-Path $work 'out'
    $cache = Join-Path $env:LOCALAPPDATA 'RabiRoute/build-cache/nuget-computer'
    & dotnet restore $project --locked-mode --packages $cache --source 'https://api.nuget.org/v3/index.json' ('-p:BaseIntermediateOutputPath='+$obj) ('-p:MSBuildProjectExtensionsPath='+$obj) --nologo
    if ($LASTEXITCODE -ne 0) { throw 'Locked computer tracking restore failed.' }
    & dotnet build $project --no-restore --configuration Release --output $out ('-p:BaseIntermediateOutputPath='+$obj) ('-p:MSBuildProjectExtensionsPath='+$obj) --nologo
    if ($LASTEXITCODE -ne 0) { throw 'Computer tracking compilation failed.' }
    foreach ($name in $spec.managedFiles) { Copy-Item -LiteralPath (Join-Path $out $name) -Destination (Join-Path $Stage $name) }
    foreach ($file in $spec.nativeFiles) {
        $native = Join-Path $cache ($file.package+'/'+$file.version+'/'+$file.source)
        if (-not (Test-Path -LiteralPath $native -PathType Leaf)) { throw 'Locked OpenCV native binding missing.' }
        Copy-Item -LiteralPath $native -Destination (Join-Path $Stage $file.path)
    }
    foreach ($notice in $spec.notices) { Copy-Item -LiteralPath (Join-Path $AgentRoot $notice.source) -Destination (Join-Path $Stage $notice.path) }
    $files = @(Get-ComputerTrackingFileNames $spec)
    $inputs = @($spec.inputs)
    $hash = { param($file) $sha=[Security.Cryptography.SHA256]::Create(); try { [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($file))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() } }
    $manifest = [ordered]@{ schemaVersion=1; architecture='win-x64'; inputs=@($inputs | ForEach-Object { @{path=$_;sha256=(&$hash (Join-Path $AgentRoot $_))} }); files=@($files | ForEach-Object { $file=Join-Path $Stage $_; @{path=$_;sha256=(&$hash $file);size=(Get-Item -LiteralPath $file).Length} }) }
    [IO.File]::WriteAllText((Join-Path $Stage 'computer-tracking-assets.json'),($manifest | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
    $full = [IO.Path]::GetFullPath($work)
    if (-not [string]::Equals([IO.Path]::GetDirectoryName($full),[IO.Path]::GetFullPath($Stage),[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($full) -ne '.tracking-build') { throw 'Tracking scratch escaped this build stage.' }
    [IO.Directory]::Delete($full,$true)
}
