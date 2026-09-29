$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/release-tracked-manifest.ps1')
$root = Join-Path $env:TEMP ('release-manifest-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $root 'scripts') -Force | Out-Null
$source = Join-Path $root 'scripts/test.mjs'
Set-Content -LiteralPath $source -Value 'export {};' -Encoding utf8
$hash = (Get-FileHash -LiteralPath $source).Hash
$manifest = Join-Path $root 'manifest.json'
function Put-Manifest($entries) { @{version=1;files=@($entries)} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifest -Encoding utf8 }
function Reject($entries) {
    Put-Manifest $entries
    $failed = $false
    try { $null = Read-ReleaseTrackedManifest $manifest $root } catch { $failed = $true }
    if (!$failed) { throw 'Unsafe manifest unexpectedly accepted' }
}
try {
    Put-Manifest @(@{path='scripts/test.mjs';sha256=$hash})
    $rows = Read-ReleaseTrackedManifest $manifest $root
    if ($rows.Count -ne 1) { throw 'Valid manifest rejected' }
    Reject @()
    Reject @(@{path='scripts/.env.local';sha256=$hash})
    Reject @(@{path='apps/rabi-agent/data/private.json';sha256=$hash})
    Reject @(@{path='scripts/../test.mjs';sha256=$hash})
    Reject @(@{path='scripts/test.mjs';sha256=('0'*64)})
    Reject @(@{path='scripts/missing.mjs';sha256=$hash})
    Reject @(@{path='data/private.json';sha256=$hash})
    Reject @(@{path='scripts/test.mjs';sha256=$hash}, @{path='scripts/TEST.mjs';sha256=$hash})
    Reject @(@{path='scripts/node_modules/x.js';sha256=$hash})
    Reject @(@{path='C:/private.json';sha256=$hash})
    $outside = Join-Path $root 'outside'; New-Item -ItemType Directory -Path $outside | Out-Null
    Set-Content -LiteralPath (Join-Path $outside 'x.js') -Value 'x'
    New-Item -ItemType Junction -Path (Join-Path $root 'scripts/link') -Target $outside | Out-Null
    Reject @(@{path='scripts/link/x.js';sha256=(Get-FileHash -LiteralPath (Join-Path $outside 'x.js')).Hash})
    Remove-Item -LiteralPath (Join-Path $root 'scripts/link') -Force
    'PASS valid snapshot and 11 negative manifest cases'
} finally { Remove-Item -LiteralPath $root -Recurse -Force }
