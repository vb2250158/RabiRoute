$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Web.Extensions,System.Drawing,System.Windows.Forms
$nativeSource = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'computer-native.cs'))
$nativeHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($nativeSource.Replace("`r`n", "`n")))).Replace('-', '').ToLowerInvariant()
$nativeAssembly = Join-Path $PSScriptRoot "../dist/native/computer-$nativeHash.dll"
if (Test-Path -LiteralPath $nativeAssembly) { Add-Type -Path $nativeAssembly }
else { Add-Type -ReferencedAssemblies System.Web.Extensions,System.Drawing,System.Windows.Forms -TypeDefinition $nativeSource }
[RabiComputer]::NativeDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "../dist/native"))
[RabiComputer]::Run()
