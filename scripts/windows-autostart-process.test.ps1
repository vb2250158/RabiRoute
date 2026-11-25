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
# Exercise production snapshot verification with the real mismatch and an isolated scheduler projection.
$preserveFunctions=@('Resolve-FullPath','Test-SamePath','Test-Under','Get-Sha256Bytes','Write-BytesDurably','Replace-File','Write-JsonDurably','Assert-SnapshotRoot','Get-PreservedTaskHash','Assert-PreservedAutostart','Save-Snapshot')
foreach ($name in $preserveFunctions) {
    $function=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
    . ([scriptblock]::Create($function.Extent.Text))
}
$currentSid='S-1-5-21-1'
$elevatedTaskName='RabiRoute.Host.Elevated.fixture'
$PreserveAutostart=$true
$autostartEntries=@(
    [pscustomobject]@{Name='settings';Path=$settingsPath},
    [pscustomobject]@{Name='startup';Path=$startupPath},
    [pscustomobject]@{Name='legacyStartup';Path=$legacyStartupPath}
)
[IO.File]::WriteAllText($settingsPath,'{ "autostart": true }')
$elevatedTask=[pscustomobject]@{
    Description="RabiRoute elevated Host; $currentSid; $install"
    Actions=@([pscustomobject]@{Execute=$hostPath;Arguments='--elevated-task';WorkingDirectory=$install})
    Triggers=@([pscustomobject]@{Enabled=$false})
}
function Export-ScheduledTask {
    param($TaskName,$TaskPath)
    if ($TaskName -cne $elevatedTaskName -or $TaskPath -cne '\') { throw 'Unexpected fixture task identity' }
    return "<LogonTrigger><Enabled>$($elevatedTask.Triggers[0].Enabled)</Enabled></LogonTrigger>"
}
$snapshot=Join-Path $work '.install-staging\fixture'
Save-Snapshot $snapshot
Assert-PreservedAutostart $snapshot
if ([IO.File]::ReadAllText($settingsPath) -cne '{ "autostart": true }' -or $elevatedTask.Triggers[0].Enabled) { throw 'Preservation reconciled the mismatch' }
$changed=$false
$elevatedTask.Triggers[0].Enabled=$true
try { Assert-PreservedAutostart $snapshot } catch { if ($_.Exception.Message -notlike '*definition changed*') { throw }; $changed=$true }
if (-not $changed) { throw 'Unexpected trigger change was accepted' }
$foreign=$false
$elevatedTask.Description='Foreign owner'
try { Assert-PreservedAutostart $snapshot } catch { if ($_.Exception.Message -notlike '*not owned*') { throw }; $foreign=$true }
if (-not $foreign) { throw 'Foreign task was accepted' }

'Windows PowerShell GUI wait, exit propagation and rollback isolation passed'


} finally {
    # Only the unique fixture directory created by this test is removed.
    $item=Get-Item -LiteralPath $work -Force
    if ($item.FullName -ne [IO.Path]::GetFullPath($work) -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Unexpected fixture cleanup target." }
    Remove-Item -LiteralPath $item.FullName -Recurse -Force
}
