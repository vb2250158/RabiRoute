function Read-ComputerGamepadAssetSpec([string]$AgentRoot) {
    return Get-Content -LiteralPath (Join-Path $AgentRoot 'desktop/gamepad/asset-spec.json') -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Get-ComputerGamepadHash([string]$File) {
    $sha = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($File)
    try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $sha.Dispose() }
}

function Copy-ComputerGamepadAssets([string]$AgentRoot, [string]$Source, [string]$Destination) {
    $spec = Read-ComputerGamepadAssetSpec $AgentRoot
    foreach ($file in $spec.files) {
        $asset = Join-Path $Source $file.name
        if ((Get-ComputerGamepadHash $asset) -ne $file.sha256) { throw "Gamepad asset differs from its pinned hash: $($file.name)" }
        Copy-Item -LiteralPath $asset -Destination (Join-Path $Destination $file.name)
    }
    $notice = Join-Path $Source $spec.notice
    Copy-Item -LiteralPath $notice -Destination (Join-Path $Destination $spec.notice)
}

function Build-ComputerGamepadAssets([string]$AgentRoot, [string]$Stage) {
    $spec = Read-ComputerGamepadAssetSpec $AgentRoot
    $cache = Join-Path $env:LOCALAPPDATA 'RabiRoute/build-cache/nuget-computer'
    [IO.Directory]::CreateDirectory($cache) | Out-Null
    $archive = Join-Path $cache (Split-Path -Leaf $spec.archive)
    if (!(Test-Path -LiteralPath $archive -PathType Leaf) -or (Get-ComputerGamepadHash $archive) -ne $spec.archiveSha256) {
        $temporary = Join-Path $cache ([guid]::NewGuid().ToString('N') + '.nupkg')
        $download = [Net.WebClient]::new()
        try {
            $download.DownloadFile([Uri]$spec.archive, $temporary)
            if ((Get-ComputerGamepadHash $temporary) -ne $spec.archiveSha256) { throw 'Unexpected ViGEmClient package hash.' }
            Copy-Item -LiteralPath $temporary -Destination $archive -Force
        } finally {
            $download.Dispose()
            if (Test-Path -LiteralPath $temporary) { [IO.File]::Delete($temporary) }
        }
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $memory = [IO.MemoryStream]::new()
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
        $stream = $zip.GetEntry($spec.assembly).Open()
        try { $stream.CopyTo($memory) } finally { $stream.Dispose() }
        $assembly = [Reflection.Assembly]::ReflectionOnlyLoad($memory.ToArray())
        foreach ($item in $spec.files) {
            $file = Join-Path $Stage $item.name
            $resource = $assembly.GetManifestResourceStream($item.resource)
            try {
                $output = [IO.File]::Create($file)
                try { $resource.CopyTo($output) } finally { $output.Dispose() }
            } finally { $resource.Dispose() }
            if ((Get-ComputerGamepadHash $file) -ne $item.sha256) { throw "Unexpected ViGEmClient resource hash: $($item.name)" }
        }
    } finally {
        $memory.Dispose()
        $zip.Dispose()
    }
    Copy-Item -LiteralPath (Join-Path $AgentRoot ('desktop/gamepad/' + $spec.notice)) -Destination (Join-Path $Stage $spec.notice)
}
