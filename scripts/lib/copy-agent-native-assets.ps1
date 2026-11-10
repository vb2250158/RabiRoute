function Copy-AgentNativeAssets([string]$AgentRoot, [string]$PayloadRoot) {
    $modules = @(
        @{ id='terminal'; name='Terminal'; source='terminal/host.ps1' },
        @{ id='computer'; name='Computer'; source='desktop/computer-native.cs'; rawSource=$true },
        @{ id='tray'; name='Tray'; source='desktop/tray.ps1' }
    )
    $destination = Join-Path $PayloadRoot 'apps/rabi-agent/dist/native'
    [IO.Directory]::CreateDirectory($destination) | Out-Null
    foreach ($module in $modules) {
        $source = [IO.File]::ReadAllText((Join-Path $AgentRoot $module.source))
        if ($module.rawSource) {
            $code = $source.Replace("`r`n", "`n")
        } else {
            $definition = [regex]::Match($source, '(?s)\$nativeSource = @''\r?\n(.*?)\r?\n''@')
            if (-not $definition.Success) { throw "Native source declaration missing: $($module.id)" }
            $code = $definition.Groups[1].Value.Replace("`r`n", "`n")
        }
        $hash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($code))).Replace('-', '').ToLowerInvariant()
        foreach ($name in @("$($module.id)-$hash.dll", "RabiAgent.$($module.name).exe")) {
            $sourceFile = Join-Path $AgentRoot "dist/native/$name"
            if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) { throw "Native release asset missing: $name" }
            if ((Get-Item -LiteralPath $sourceFile -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Native release asset is a reparse point: $name" }
            [Reflection.AssemblyName]::GetAssemblyName($sourceFile) | Out-Null
            $target = Join-Path $destination $name
            Copy-Item -LiteralPath $sourceFile -Destination $target
            $sha = [Security.Cryptography.SHA256]::Create()
            try {
                $sourceHash = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($sourceFile)))
                $targetHash = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($target)))
                if ($sourceHash -ne $targetHash) { throw "Native release asset copy mismatch: $name" }
            } finally { $sha.Dispose() }
        }
    }
    $hashFile = { param($file) $sha=[Security.Cryptography.SHA256]::Create(); try { [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($file))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() } }
    $trackingManifest = Join-Path $AgentRoot 'dist/native/computer-tracking-assets.json'
    $tracking = Get-Content -LiteralPath $trackingManifest -Raw | ConvertFrom-Json
    . (Join-Path $PSScriptRoot 'build-computer-tracking.ps1')
    $trackingSpec = Read-ComputerTrackingAssetSpec $AgentRoot
    Assert-ComputerTrackingManifest $tracking $trackingSpec
    if ($tracking.schemaVersion -ne 1 -or $tracking.architecture -ne 'win-x64') { throw 'Computer tracking assets have an unsupported manifest.' }
    foreach ($input in $tracking.inputs) {
        if ($input.path -notin $trackingSpec.inputs) { throw 'Unexpected computer tracking source input.' }
        if ((&$hashFile (Join-Path $AgentRoot $input.path)) -ne $input.sha256) { throw 'Computer tracking source differs from its built assets.' }
    }
    foreach ($file in $tracking.files) {
        if ($file.path -notmatch '^[A-Za-z0-9_.-]+$') { throw 'Invalid computer tracking asset path.' }
        $sourceFile = Join-Path $AgentRoot ('dist/native/'+$file.path)
        if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) { throw "Computer tracking release asset missing: $($file.path)" }
        if ((Get-Item -LiteralPath $sourceFile -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Computer tracking asset is a reparse point.' }
        if ((&$hashFile $sourceFile) -ne $file.sha256) { throw 'Computer tracking asset hash differs.' }
        Copy-Item -LiteralPath $sourceFile -Destination (Join-Path $destination $file.path)
        if ((&$hashFile (Join-Path $destination $file.path)) -ne $file.sha256) { throw 'Computer tracking copied asset differs.' }
    }
    Copy-Item -LiteralPath $trackingManifest -Destination (Join-Path $destination 'computer-tracking-assets.json')

}
