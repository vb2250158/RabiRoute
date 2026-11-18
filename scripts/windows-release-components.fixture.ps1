$ErrorActionPreference='Stop'
$repo=Split-Path $PSScriptRoot -Parent
$script=Join-Path $repo 'scripts\Install-RabiRouteReleaseTransaction.ps1'
$tokens=$null;$errors=$null;$ast=[System.Management.Automation.Language.Parser]::ParseFile($script,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Source parse failed'}
foreach($name in @('Full','Is-Under','Assert-NoReparse','Get-Sha256File','Read-Candidate')) {
  $f=$ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
  if($f.Count -ne 1){throw "Function extraction failed: $name"}
  $definitionText = $f[0].Extent.Text.Replace('$PSScriptRoot', '$TrustedRulesRoot')
  Invoke-Expression $definitionText
}
$TrustedRulesRoot=$PSScriptRoot;$AppId='io.rabiroute.windows';$base=Join-Path ([IO.Path]::GetTempPath()) ('rabi-component-fixture-'+[guid]::NewGuid().ToString('N'));New-Item -ItemType Directory $base|Out-Null
try {
 $versionTemp=Join-Path $base 'v';New-Item -ItemType Directory $versionTemp|Out-Null
 $paths=@('RabiRouteHost.Core.dll','node.exe','dist/manager.js','ribiwebgui/dist/index.html','desktop-runtime/main.py','desktop-runtime/python/python.exe','dist/plugins/essential.js','node_modules/@openai/optional.js')
 $entries=@(foreach($relative in $paths){$p=Join-Path $versionTemp ($relative -replace '/','\');New-Item -ItemType Directory -Force (Split-Path $p)|Out-Null;[IO.File]::WriteAllText($p,"fixture:$relative",[Text.UTF8Encoding]::new($false));[ordered]@{path=$relative;size=(Get-Item $p).Length;sha256=(Get-Sha256File $p)}})
 $sb=[Text.StringBuilder]::new();foreach($e in $entries){[void]$sb.Append($e.path+"`0"+[long]$e.size+"`0"+$e.sha256+"`n")};$sha=[Security.Cryptography.SHA256]::Create();try{$digest=([BitConverter]::ToString($sha.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($sb.ToString())))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()};$id="9.9.9-$($digest.Substring(0,12))"
 $candidate=Join-Path $base 'candidate';$v=Join-Path $candidate "versions\$id";New-Item -ItemType Directory -Force (Split-Path $v)|Out-Null;Move-Item $versionTemp $v;[IO.File]::WriteAllText((Join-Path $candidate 'RabiRouteHost.exe'),'fixture')
 @{schemaVersion=1;appId=$AppId;releaseId=$id;versionPath="versions/$id";payloadSha256=$digest}|ConvertTo-Json|Set-Content (Join-Path $candidate 'current.json') -Encoding utf8
 @{schemaVersion=1;appId=$AppId;releaseId=$id;packageVersion='9.9.9';payloadSha256=$digest;files=$entries}|ConvertTo-Json -Depth 8|Set-Content (Join-Path $v 'release-manifest.json') -Encoding utf8
 $core=@{id='core';required=$true;manifestPrefixes=@()};$desktop=@{id='desktop';required=$true;manifestPrefixes=@('desktop-runtime/')};$optional=@{id='agent-codex';required=$false;manifestPrefixes=@('node_modules/@openai/')}
 $cli=@{id='agent-cli';required=$false;manifestPrefixes=@('apps/rabi-agent/')}
 function SetMap($rows){@{schemaVersion=1;releaseId=$id;components=$rows}|ConvertTo-Json -Depth 8|Set-Content (Join-Path $candidate 'components.json') -Encoding utf8}
 function Check([string]$name,[string]$selection){$script:ComponentsInstalled=$selection;try{[void](Read-Candidate $candidate $id);return @{name=$name;accepted=$true}}catch{return @{name=$name;accepted=$false;error=$_.Exception.Message}}}
 $out=@();SetMap @($core,$desktop,$optional,$cli);$out+=Check 'full-old-portable' '';Remove-Item -LiteralPath (Join-Path $v 'node_modules\@openai\optional.js');$out+=Check 'legitimate-optional-omitted' 'core,desktop'
 SetMap @($core,$desktop,@{id='agent-codex';required=$false;manifestPrefixes=@('node_modules/@openai/','dist/plugins/')});Remove-Item -LiteralPath (Join-Path $v 'dist\plugins\essential.js');$out+=Check 'tampered-prefix-required-plugin-missing' 'core,desktop'
 [IO.File]::WriteAllText((Join-Path $v 'dist\plugins\essential.js'),'wrong');$out+=Check 'tampered-prefix-present-hash-mismatch' 'core,desktop'
 [IO.File]::WriteAllText((Join-Path $v 'dist\plugins\essential.js'),'fixture:dist/plugins/essential.js',[Text.UTF8Encoding]::new($false));SetMap @($core,$desktop,$optional,$cli);$out+=Check 'unknown-selected-component' 'core,desktop,unknown-component'
 SetMap @($core,$optional,$cli);$out+=Check 'missing-required-component-definition' 'core'
 SetMap @($core,$desktop,$optional,$cli);$out+=Check 'required-component-not-selected' 'core'
 [IO.File]::WriteAllText((Join-Path $v 'node_modules\@openai\optional.js'),'wrong');$out+=Check 'unselected-existing-file-bad-hash' 'core,desktop'
 $state=Get-Content -Raw (Join-Path $candidate 'components.json')|ConvertFrom-Json;$state.releaseId='9.9.9-wrong';$state|ConvertTo-Json -Depth 8|Set-Content (Join-Path $candidate 'components.json') -Encoding utf8;$out+=Check 'component-release-mismatch' 'core,desktop'
 $out|ConvertTo-Json -Depth 6 -Compress
} finally { Remove-Item -LiteralPath $base -Recurse -Force }
