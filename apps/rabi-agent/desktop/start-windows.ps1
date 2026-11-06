param(
    [string]$Config = (Join-Path $env:LOCALAPPDATA 'RabiAgent/config.json'),
    [switch]$Bootstrap
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$profilePath = Join-Path $root 'windows-runtime.json'
if (-not (Test-Path -LiteralPath $profilePath -PathType Leaf)) { throw 'Use the explicit Windows runtime bundle for this entry. Existing Node source releases retain their original entry.' }
$node = Join-Path $root 'windows-runtime/RabiAgent.Runtime.exe'
$arguments = @((Join-Path $root 'lib/windows-runtime.mjs'),'--config',[IO.Path]::GetFullPath($Config))
if ($Bootstrap) { $arguments += '--bootstrap' }
& $node @arguments
if ($LASTEXITCODE -ne 0) { throw 'Rabi Agent Windows runtime preparation or startup failed; inspect the original instance and private runtime receipt.' }
