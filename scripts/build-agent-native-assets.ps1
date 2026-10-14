param([Parameter(Mandatory=$true)][string]$AgentRoot)
$ErrorActionPreference = 'Stop'
$agentDirectory = [IO.Path]::GetFullPath($AgentRoot)
if ($agentDirectory.StartsWith('\\')) { throw 'Native build output must be on a local disk.' }
$outputDirectory = Join-Path $agentDirectory 'dist/native'
[IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
$modules = @(
    @{ id='terminal'; source='terminal/host.ps1'; references=@('System.Web.Extensions') },
    @{ id='computer'; source='desktop/computer.ps1'; references=@('System.Web.Extensions','System.Drawing','System.Windows.Forms') },
    @{ id='tray'; source='desktop/tray.ps1'; references=@('System.Web.Extensions','System.Drawing','System.Windows.Forms') }
)
foreach ($module in $modules) {
    $source = [IO.File]::ReadAllText((Join-Path $agentDirectory $module.source))
    $definition = [regex]::Match($source, '(?s)\$nativeSource = @''\r?\n(.*?)\r?\n''@')
    if (-not $definition.Success) { throw "Native source declaration missing: $($module.id)" }
    $code = $definition.Groups[1].Value.Replace("`r`n", "`n")
    $hash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($code))).Replace('-', '').ToLowerInvariant()
    $assembly = Join-Path $outputDirectory "$($module.id)-$hash.dll"
    if (-not (Test-Path -LiteralPath $assembly)) {
        $temporary = Join-Path $outputDirectory "$($module.id)-$hash-$([guid]::NewGuid().ToString('N')).tmp.dll"
        try {
            Add-Type -ReferencedAssemblies $module.references -TypeDefinition $code -OutputAssembly $temporary
            [IO.File]::Move($temporary, $assembly)
        } finally {
            if (Test-Path -LiteralPath $temporary) { [IO.File]::Delete($temporary) }
        }
    }
    # Validate that the output is an assembly, then retire only this builder's
    # obsolete source hashes. Never touch installed application directories.
    [Reflection.AssemblyName]::GetAssemblyName($assembly) | Out-Null
    foreach ($old in [IO.Directory]::GetFiles($outputDirectory, "$($module.id)-*.dll")) {
        if ($old -ne $assembly -and [IO.Path]::GetFileName($old) -match ('^'+$module.id+'-[a-f0-9]{64}\.dll$')) { [IO.File]::Delete($old) }
    }
    Write-Output "Native release asset ready: $($module.id)-$hash.dll"
}
