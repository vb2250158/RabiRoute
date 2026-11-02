$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/copy-installed-host.ps1')
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('rabi-host-test-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($testRoot) | Out-Null
$install = Join-Path $testRoot 'install'
$version = Join-Path $install 'versions/test-release'
[IO.Directory]::CreateDirectory($version) | Out-Null
$bootstrap = Join-Path $install 'RabiRouteHost.exe'
[IO.File]::WriteAllText($bootstrap, 'bootstrap')
$entries = @()
foreach ($name in @('RabiRouteHost.Core.dll', 'RabiRouteHost.Core.deps.json')) {
    $path = Join-Path $version $name
    [IO.File]::WriteAllText($path, "fixture-$name")
    $entries += [ordered]@{ path = $name; size = (Get-Item -LiteralPath $path).Length; sha256 = (Get-FileHash -LiteralPath $path).Hash.ToLowerInvariant() }
}
$canonical = [Text.StringBuilder]::new()
foreach ($entry in $entries) { $null = $canonical.Append($entry.path).Append([char]0).Append($entry.size).Append([char]0).Append($entry.sha256).Append("`n") }
$sha = [Security.Cryptography.SHA256]::Create()
try { $digest = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonical.ToString()))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
$manifestPath = Join-Path $version 'release-manifest.json'
$pointerPath = Join-Path $install 'current.json'
$manifest = [ordered]@{ schemaVersion = 1; appId = 'io.rabiroute.windows'; releaseId = 'test-release'; payloadSha256 = $digest; files = $entries }
$pointer = [ordered]@{ schemaVersion = 1; appId = 'io.rabiroute.windows'; releaseId = 'test-release'; versionPath = 'versions/test-release'; payloadSha256 = $digest }
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 8))
[IO.File]::WriteAllText($pointerPath, ($pointer | ConvertTo-Json -Depth 8))
$bootstrapHash = (Get-FileHash -LiteralPath $bootstrap).Hash
function Assert-Rejected([scriptblock]$Action, [string]$Label) {
    $rejected = $false
    try { & $Action } catch { $rejected = $true }
    if (!$rejected) { throw "Expected rejection: $Label" }
}
$destination = Join-Path $testRoot 'good'
Copy-InstalledHostSnapshot $install $destination $bootstrapHash
foreach ($name in @('RabiRouteHost.Core.dll', 'RabiRouteHost.Core.deps.json')) {
    if ((Get-FileHash (Join-Path $version $name)).Hash -ne (Get-FileHash (Join-Path $destination "version/$name")).Hash) { throw "Copy mismatch: $name" }
}
Assert-Rejected { Copy-InstalledHostSnapshot $install $destination $bootstrapHash } 'existing destination'
Assert-Rejected { Copy-InstalledHostSnapshot $install (Join-Path $testRoot 'wrong-hash') ('0' * 64) } 'bootstrap mismatch'
$core = Join-Path $version 'RabiRouteHost.Core.dll'
$original = [IO.File]::ReadAllText($core)
[IO.File]::WriteAllText($core, 'corrupt')
Assert-Rejected { Copy-InstalledHostSnapshot $install (Join-Path $testRoot 'bad-core') $bootstrapHash } 'core mismatch'
[IO.File]::WriteAllText($core, $original)
$manifest.files[0].sha256 = '0' * 64
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 8))
Assert-Rejected { Copy-InstalledHostSnapshot $install (Join-Path $testRoot 'bad-manifest') $bootstrapHash } 'manifest digest mismatch'
$pointer.versionPath = 'versions/../test-release'
[IO.File]::WriteAllText($pointerPath, ($pointer | ConvertTo-Json -Depth 8))
Assert-Rejected { Copy-InstalledHostSnapshot $install (Join-Path $testRoot 'bad-pointer') $bootstrapHash } 'pointer traversal'
$junction = Join-Path $testRoot 'junction'
cmd /c mklink /J $junction $install | Out-Null
Assert-Rejected { Copy-InstalledHostSnapshot $junction (Join-Path $testRoot 'bad-junction') $bootstrapHash } 'reparse point'
(Get-Item -LiteralPath $junction -Force).Delete()
Write-Output 'Installed Host snapshot tests passed'
