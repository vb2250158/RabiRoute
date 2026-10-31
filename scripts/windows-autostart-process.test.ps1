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
# Execute the production rollback with real owned files and a failed task command.
$rollback=$ast.Find({param($n) $n -is [Management.Automation.Language.CatchClauseAst] -and $n.Body.Extent.Text -like '*$restoreActions*'},$true)
if(-not $rollback){throw 'Production autostart rollback block missing'}
$settingsPath=Join-Path $work 'settings.json';$startupPath=Join-Path $work 'startup.lnk';$legacyStartupPath=Join-Path $work 'legacy.lnk'
$settingsBytes=[Text.Encoding]::UTF8.GetBytes('original-settings');$startupBytes=[Text.Encoding]::UTF8.GetBytes('original-startup');$legacyBytes=[Text.Encoding]::UTF8.GetBytes('original-legacy')
$settingsExisted=$true;$startupExisted=$true;$legacyExisted=$true
foreach($file in @($settingsPath,$startupPath,$legacyStartupPath)){[IO.File]::WriteAllText($file,'changed')}
$elevatedTask=@{Triggers=@(@{Enabled=$true})}
function Invoke-ElevatedHostAutostart { param($EnabledValue) throw 'task-rollback-failed' }
$observed=$null
$rollbackText=$rollback.Body.Extent.Text
$rollbackBlock=[scriptblock]::Create($rollbackText.Substring(1,$rollbackText.Length-2))
try { try { throw 'original-update-failed' } catch { & $rollbackBlock } } catch { $observed=$_.Exception }
if(-not $observed -or $observed.InnerExceptions.Count -ne 2 -or $observed.InnerExceptions[0].Message -notlike '*original-update-failed*' -or $observed.InnerExceptions[1].Message -notlike '*task-rollback-failed*'){throw ('Original and rollback failures were not retained: ' + $observed.ToString())}
if([IO.File]::ReadAllText($settingsPath) -ne 'original-settings' -or [IO.File]::ReadAllText($startupPath) -ne 'original-startup' -or [IO.File]::ReadAllText($legacyStartupPath) -ne 'original-legacy'){throw 'Failed task rollback skipped owned file restoration'}
'Windows PowerShell GUI wait, exit propagation and rollback isolation passed'


} finally {
    # Only the unique fixture directory created by this test is removed.
    $item=Get-Item -LiteralPath $work -Force
    if ($item.FullName -ne [IO.Path]::GetFullPath($work) -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Unexpected fixture cleanup target." }
    Remove-Item -LiteralPath $item.FullName -Recurse -Force
}
