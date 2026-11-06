function Copy-AgentNativeAssets([string]$AgentRoot, [string]$PayloadRoot) {
    $modules = @(
        @{ id='terminal'; name='Terminal'; source='terminal/host.ps1' },
        @{ id='computer'; name='Computer'; source='desktop/computer.ps1' },
        @{ id='tray'; name='Tray'; source='desktop/tray.ps1' }
    )
    $destination = Join-Path $PayloadRoot 'apps/rabi-agent/dist/native'
    [IO.Directory]::CreateDirectory($destination) | Out-Null
    foreach ($module in $modules) {
        $source = [IO.File]::ReadAllText((Join-Path $AgentRoot $module.source))
        $definition = [regex]::Match($source, '(?s)\$nativeSource = @''\r?\n(.*?)\r?\n''@')
        if (-not $definition.Success) { throw "Native source declaration missing: $($module.id)" }
        $code = $definition.Groups[1].Value.Replace("`r`n", "`n")
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
}
