$ErrorActionPreference='Stop'
$work=Join-Path ([IO.Path]::GetTempPath()) ('rabiroute-autostart-gui-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work|Out-Null
try {
$hostPath=Join-Path $work 'GuiHost.exe';$install=$work
Add-Type -TypeDefinition 'using System;using System.IO;using System.Threading;public static class GuiHost { [STAThread]public static int Main(string[] args){Thread.Sleep(600);string exe=System.Reflection.Assembly.GetExecutingAssembly().Location; File.WriteAllText(exe+".completed","done");return File.Exists(exe+".fail")?7:0;} }' -OutputAssembly $hostPath -OutputType WindowsApplication
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'Configure-WindowsAutostart.ps1'),[ref]$tokens,[ref]$errors)
$f=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-ElevatedHostAutostart'},$true)
. ([scriptblock]::Create($f.Extent.Text))
$timer=[Diagnostics.Stopwatch]::StartNew();Invoke-ElevatedHostAutostart 'true'
if(-not (Test-Path -LiteralPath ($hostPath+'.completed')) -or $timer.ElapsedMilliseconds -lt 500){throw 'GUI command was not awaited'}
[IO.File]::WriteAllText(($hostPath+'.fail'),'fail')
$denied=$false;try{Invoke-ElevatedHostAutostart 'false'}catch{if($_.Exception.Message -notlike '*ExitCode=7*'){throw};$denied=$true}
if(-not $denied){throw 'Nonzero GUI process exit was ignored'}
'Windows PowerShell real GUI wait and exit propagation passed'


} finally {
    # Only the unique fixture directory created by this test is removed.
    $item=Get-Item -LiteralPath $work -Force
    if ($item.FullName -ne [IO.Path]::GetFullPath($work) -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Unexpected fixture cleanup target." }
    Remove-Item -LiteralPath $item.FullName -Recurse -Force
}
