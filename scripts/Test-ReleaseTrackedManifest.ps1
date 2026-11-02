$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/release-tracked-manifest.ps1')
$tempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\', '/')
$root = [IO.Path]::GetFullPath((Join-Path $tempRoot ('release-manifest-test-' + [guid]::NewGuid().ToString('N'))))
if (!$root.StartsWith($tempRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test root' }
New-Item -ItemType Directory -Path (Join-Path $root 'scripts') -Force | Out-Null
$source = Join-Path $root 'scripts/test.mjs'
Set-Content -LiteralPath $source -Value 'export {};' -Encoding utf8
$hash = (Get-FileHash -LiteralPath $source).Hash
$pluginDir = Join-Path $root 'plugins/builtin/example'
New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null
$plugin = Join-Path $pluginDir 'manager.mjs'
Set-Content -LiteralPath $plugin -Value 'export {};' -Encoding utf8
$pluginHash = (Get-FileHash -LiteralPath $plugin).Hash
$privateDir = Join-Path $pluginDir 'data'
New-Item -ItemType Directory -Path $privateDir -Force | Out-Null
Set-Content -LiteralPath (Join-Path $privateDir 'private.json') -Value '{}'
Set-Content -LiteralPath (Join-Path $pluginDir '.env.local') -Value 'fixture'
$manifest = Join-Path $root 'manifest.json'
function Put-Manifest($entries) { @{version=1;files=@($entries)} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifest -Encoding utf8 }
function Reject($entries) {
    Put-Manifest $entries
    $failed = $false
    try { $null = Read-ReleaseTrackedManifest $manifest $root } catch { $failed = $true }
    if (!$failed) { throw 'Unsafe manifest unexpectedly accepted' }
}
try {
    Put-Manifest @(@{path='scripts/test.mjs';sha256=$hash}, @{path='plugins/builtin/example/manager.mjs';sha256=$pluginHash})
    $rows = Read-ReleaseTrackedManifest $manifest $root
    if ($rows.Count -ne 2) { throw 'Valid manifest rejected' }
    Reject @()
    Reject @(@{path='scripts/.env.local';sha256=$hash})
    Reject @(@{path='apps/rabi-agent/data/private.json';sha256=$hash})
    Reject @(@{path='plugins/builtin/example/data/private.json';sha256=$hash})
    Reject @(@{path='plugins/builtin/example/.env.local';sha256=$hash})
    Reject @(@{path='scripts/../test.mjs';sha256=$hash})
    Reject @(@{path='scripts/test.mjs';sha256=('0'*64)})
    Reject @(@{path='scripts/missing.mjs';sha256=$hash})
    Reject @(@{path='data/private.json';sha256=$hash})
    Reject @(@{path='scripts/test.mjs';sha256=$hash}, @{path='scripts/TEST.mjs';sha256=$hash})
    Reject @(@{path='scripts/node_modules/x.js';sha256=$hash})
    Reject @(@{path='C:/private.json';sha256=$hash})
    & git -C $root init -q
    if ($LASTEXITCODE -ne 0) { throw 'Git fixture initialization failed' }
    & git -C $root add -f -- 'plugins/builtin/example/manager.mjs' 'plugins/builtin/example/.env.local' 'plugins/builtin/example/data/private.json'
    if ($LASTEXITCODE -ne 0) { throw 'Git fixture staging failed' }
    $tracked = @(& git -C $root ls-files -- 'plugins/*')
    if ($LASTEXITCODE -ne 0 -or $tracked.Count -ne 3) { throw 'Git fixture enumeration failed' }
    foreach ($path in $tracked) {
        $accepted = $true
        try { $null = Resolve-ReleaseTrackedSourcePath $path $root } catch { $accepted = $false }
        if ($accepted -ne ($path -eq 'plugins/builtin/example/manager.mjs')) { throw 'Git tracked path validation failed' }
    }
    $outside = Join-Path $root 'outside'; New-Item -ItemType Directory -Path $outside | Out-Null
    Set-Content -LiteralPath (Join-Path $outside 'x.js') -Value 'x'
    New-Item -ItemType Junction -Path (Join-Path $root 'scripts/link') -Target $outside | Out-Null
    Reject @(@{path='scripts/link/x.js';sha256=(Get-FileHash -LiteralPath (Join-Path $outside 'x.js')).Hash})
    $failed = $false
    try { $null = Resolve-ReleaseTrackedSourcePath 'scripts/link/x.js' $root } catch { $failed = $true }
    if (!$failed) { throw 'Git tracked reparse path unexpectedly accepted' }
    (Get-Item -LiteralPath (Join-Path $root 'scripts/link') -Force).Delete()
    'PASS valid tracked plugin snapshot and unsafe manifest cases'
} finally { Remove-Item -LiteralPath $root -Recurse -Force }
