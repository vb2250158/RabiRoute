param([Parameter(Mandatory=$true)][string]$AgentRoot)
$ErrorActionPreference = 'Stop'
$agentDirectory = [IO.Path]::GetFullPath($AgentRoot)
if ($agentDirectory.StartsWith('\\')) { throw 'Native build output must be on a local disk.' }
if (Test-Path -LiteralPath (Join-Path $agentDirectory 'release-identity.json')) {
    throw 'Build native assets from source before signing; an installed signed release is immutable.'
}
$outputDirectory = Join-Path $agentDirectory 'dist/native'
$parentDirectory = Split-Path -Parent $outputDirectory
[IO.Directory]::CreateDirectory($parentDirectory) | Out-Null
$stage = Join-Path $parentDirectory ('.native-candidate-' + [guid]::NewGuid().ToString('N'))
$backup = Join-Path $parentDirectory ('.native-before-' + [guid]::NewGuid().ToString('N'))
function Remove-BuildScratch([string]$PathValue) {
    $full = [IO.Path]::GetFullPath($PathValue)
    if (-not [string]::Equals([IO.Path]::GetDirectoryName($full),$parentDirectory,[StringComparison]::OrdinalIgnoreCase) `
        -or [IO.Path]::GetFileName($full) -notmatch '^\.native-(candidate|before)-[a-f0-9]{32}$') {
        throw 'Refusing to remove a path outside this native build scratch scope.'
    }
    if (([IO.File]::GetAttributes($full) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Native build scratch cannot be a reparse point.' }
    [IO.Directory]::Delete($full,$true)
}
$icon = Join-Path $agentDirectory 'desktop/rabi-agent.ico'
$version = [Version]((Get-Content -LiteralPath (Join-Path $agentDirectory 'package.json') -Raw | ConvertFrom-Json).version)
$assemblyVersion = '{0}.{1}.{2}.0' -f $version.Major,$version.Minor,$version.Build
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { $compiler = Join-Path $env:SystemRoot 'Microsoft.NET/Framework/v4.0.30319/csc.exe' }
foreach ($required in @($icon,$compiler)) { if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Native build input is missing: $required" } }
$iconHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([IO.File]::ReadAllBytes($icon))).Replace('-', '').ToLowerInvariant()
$modules = @(
    @{ id='terminal'; name='Terminal'; type='RabiTerminalHost'; source='terminal/host.ps1'; references=@('System.Web.Extensions') },
    @{ id='computer'; name='Computer'; type='RabiComputer'; source='desktop/computer.ps1'; references=@('System.Web.Extensions','System.Drawing','System.Windows.Forms') },
    @{ id='tray'; name='Tray'; type='RabiAgentPresentation'; source='desktop/tray.ps1'; references=@('System.Web.Extensions','System.Drawing','System.Windows.Forms') }
)
try {
    [IO.Directory]::CreateDirectory($stage) | Out-Null
    if (Test-Path -LiteralPath $outputDirectory) {
        Get-ChildItem -LiteralPath $outputDirectory -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $stage -Recurse -Force }
    }
foreach ($module in $modules) {
    $source = [IO.File]::ReadAllText((Join-Path $agentDirectory $module.source))
    $definition = [regex]::Match($source, '(?s)\$nativeSource = @''\r?\n(.*?)\r?\n''@')
    if (-not $definition.Success) { throw "Native source declaration missing: $($module.id)" }
    $code = $definition.Groups[1].Value.Replace("`r`n", "`n")
    $hash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($code))).Replace('-', '').ToLowerInvariant()
    $assembly = Join-Path $stage "$($module.id)-$hash.dll"
    if (-not (Test-Path -LiteralPath $assembly)) {
        $temporary = Join-Path $stage ".native-$([guid]::NewGuid().ToString('N')).tmp.dll"
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
    foreach ($old in [IO.Directory]::GetFiles($stage, "$($module.id)-*.dll")) {
        if ($old -ne $assembly -and [IO.Path]::GetFileName($old) -match ('^'+$module.id+'-[a-f0-9]{64}\.dll$')) { [IO.File]::Delete($old) }
    }
    $iconSetup = if ($module.id -eq 'tray') {
        'RabiAgentPresentation.IconPath = System.IO.Path.GetFullPath(System.IO.Path.Combine(System.AppDomain.CurrentDomain.BaseDirectory, "../../desktop/rabi-agent.ico"));'
    } else { '' }
    $entry = @"
[assembly:System.Reflection.AssemblyTitle("Rabi Agent $($module.name)")]
[assembly:System.Reflection.AssemblyDescription("Rabi Agent $($module.name)")]
[assembly:System.Reflection.AssemblyProduct("RabiRoute")]
[assembly:System.Reflection.AssemblyVersion("$assemblyVersion")]
[assembly:System.Reflection.AssemblyFileVersion("$assemblyVersion")]
internal static class RabiAgentNativeMain {
    [System.STAThread] static int Main() {
        // WinExe has redirected pipes rather than a console code page.
        // Console.InputEncoding would call SetConsoleCP and fail for this host.
        System.Console.SetIn(new System.IO.StreamReader(System.Console.OpenStandardInput(), new System.Text.UTF8Encoding(false), false));
        System.Console.SetOut(new System.IO.StreamWriter(System.Console.OpenStandardOutput(), new System.Text.UTF8Encoding(false)) { AutoFlush = true });
        System.Console.SetError(new System.IO.StreamWriter(System.Console.OpenStandardError(), new System.Text.UTF8Encoding(false)) { AutoFlush = true });
        $iconSetup
        $($module.type).Run();
        return 0;
    }
}
"@
    $nativeName = "RabiAgent.$($module.name).exe"
    $exeHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($code + $entry + $iconHash + $nativeName))).Replace('-', '').ToLowerInvariant()
    $cachedExe = Join-Path $stage "$($module.id)-$exeHash.exe"
    if (-not (Test-Path -LiteralPath $cachedExe)) {
        $sourceFile = Join-Path $stage ('.native-' + [guid]::NewGuid().ToString('N') + '.cs')
        $entryFile = $sourceFile + '.entry.cs'
        try {
            [IO.File]::WriteAllText($sourceFile,$code,[Text.UTF8Encoding]::new($false))
            [IO.File]::WriteAllText($entryFile,$entry,[Text.UTF8Encoding]::new($false))
            $compiledExe = Join-Path $stage $nativeName
            $arguments = @('/nologo','/target:winexe','/optimize+','/platform:anycpu','/codepage:65001',('/out:'+$compiledExe),('/win32icon:'+$icon))
            foreach ($reference in $module.references) { $arguments += '/reference:' + $reference + '.dll' }
            & $compiler @arguments $sourceFile $entryFile
            if ($LASTEXITCODE -ne 0) { throw "Native $($module.id) executable compilation failed." }
            [IO.File]::Move($compiledExe,$cachedExe)
        } finally {
            foreach ($file in @($sourceFile,$entryFile)) { if (Test-Path -LiteralPath $file) { [IO.File]::Delete($file) } }
        }
    }
    [Reflection.AssemblyName]::GetAssemblyName($cachedExe) | Out-Null
    Copy-Item -LiteralPath $cachedExe -Destination (Join-Path $stage $nativeName) -Force
    foreach ($old in [IO.Directory]::GetFiles($stage, "$($module.id)-*.exe")) {
        if ($old -ne $cachedExe -and [IO.Path]::GetFileName($old) -match ('^'+$module.id+'-[a-f0-9]{64}\.exe$')) { [IO.File]::Delete($old) }
    }
    Write-Output "Native release asset ready: $($module.id)-$hash.dll"
}
    # Prepare the complete set first. A failed compiler leaves the prior set intact.
    $hadPrevious = Test-Path -LiteralPath $outputDirectory
    if ($hadPrevious) { [IO.Directory]::Move($outputDirectory,$backup) }
    try { [IO.Directory]::Move($stage,$outputDirectory) }
    catch { if ($hadPrevious) { [IO.Directory]::Move($backup,$outputDirectory) }; throw }
    if ($hadPrevious) { Remove-BuildScratch $backup }
} finally {
    if (Test-Path -LiteralPath $stage) { Remove-BuildScratch $stage }
}
