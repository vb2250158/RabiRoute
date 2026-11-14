import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("HA OS discovery selects a responding 80 or 8123 endpoint and ignores unready addresses", { skip: process.platform !== "win32" }, () => {
  const source = fileURLToPath(new URL("../src/plugins/io.rabiroute.manager.xiaomi-home/scripts/Install-HomeAssistantOs.ps1", import.meta.url));
  const script = `
$ErrorActionPreference='Stop'; $tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile('${source.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)
$function=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Wait-HomeAssistantCore'},$true)
Invoke-Expression $function.Extent.Text
function Get-VMNetworkAdapter { param($VM) return @{IPAddresses=@('192.0.2.1','192.0.2.2')} }
function Test-HomeAssistantCore { param($Address,$Port) return $Address -eq '192.0.2.2' -and $Port -eq $script:readyPort }
foreach($port in @(80,8123)) {
  $script:readyPort=$port; $endpoint=Wait-HomeAssistantCore @{Id='fixture'} 1
  if($endpoint.address -ne '192.0.2.2' -or $endpoint.port -ne $port){throw "Endpoint discovery failed for $port"}
}
`;
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 15000 });
});

test("read-only observation verifies VM ownership and never starts or mutates the VM", { skip: process.platform !== "win32" }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "haos-observe-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "image.json"), "{}", "utf8");
  fs.writeFileSync(path.join(root, "status.json"), "unchanged", "utf8");
  const source = fileURLToPath(new URL("../src/plugins/io.rabiroute.manager.xiaomi-home/scripts/Install-HomeAssistantOs.ps1", import.meta.url));
  const literal = value => `'${value.replaceAll("'", "''")}'`;
  const script = `
$ErrorActionPreference='Stop'; $tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile(${literal(source)},[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Installer syntax errors'}
$function=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-OwnedReadyEndpoint'},$true)
Invoke-Expression $function.Extent.Text
$Root=${literal(root)}; $script:probes=0; $script:readyPort=80
$script:vm=@{Id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';Notes=('RabiRoute Home Assistant OS: '+$Root);State='Running'}
function Get-VM { param($Name,$ErrorAction) return $script:vm }
function Get-VMHardDiskDrive { param($VM) return @{Path=(Join-Path $Root 'home-assistant.vhdx')} }
function Test-InstallationDisk { param($AttachedPath,$ExpectedPath,$RejectReparse) if(-not $RejectReparse){throw 'Observation did not reject reparse points'}; return $AttachedPath -eq $ExpectedPath }
function Get-VMNetworkAdapter { param($VM) return @{IPAddresses=@('192.0.2.42')} }
function Test-HomeAssistantCore { param($Address,$Port) $script:probes++; return $Port -eq $script:readyPort }
function Test-OwnedLegacyLoopback { param($VM) return $true }
function Start-VM { throw 'Observe must not start a VM' }
function Stop-VM { throw 'Observe must not stop a VM' }
function Set-VM { throw 'Observe must not modify a VM' }
foreach($port in @(80,8123)) {
  $script:readyPort=$port; $result=Get-OwnedReadyEndpoint
  if(-not $result.ready -or $result.address -ne '192.0.2.42' -or $result.port -ne $port -or -not $result.legacyBindingVerified){throw 'Owned ready VM was not observed'}
}
$script:vm.State='Off'; $before=$script:probes
$stopped=Get-OwnedReadyEndpoint
if($stopped.ready -or $stopped.diagnostics.reason -ne 'vm_not_running' -or $stopped.diagnostics.vmState -ne 'Off' -or $script:probes -ne $before){throw 'Stopped VM was probed or its diagnostic was lost'}
$script:vm.State='Running'; $script:readyPort=443
$unready=Get-OwnedReadyEndpoint
if($unready.ready -or $unready.diagnostics.reason -ne 'core_unready' -or $unready.diagnostics.guestAddresses[0] -ne '192.0.2.42'){throw 'Core readiness failure was not diagnosed'}
function Get-VMNetworkAdapter { param($VM) return @{IPAddresses=@()} }
$noAddress=Get-OwnedReadyEndpoint
if($noAddress.ready -or $noAddress.diagnostics.reason -ne 'no_guest_address' -or $noAddress.diagnostics.guestAddresses.Count){throw 'Missing guest address was not diagnosed'}
function Get-VMNetworkAdapter { throw 'Foreign VM network details must not be queried' }
$script:vm.State='Running'; $script:vm.Notes='foreign'; $before=$script:probes; $rejected=$false
try { Get-OwnedReadyEndpoint } catch { $rejected=$true }
if(-not $rejected -or $script:probes -ne $before){throw 'Foreign VM was accepted or probed'}
function Get-VM { param($Name,$ErrorAction) if($ErrorAction -ne 'Stop'){throw 'Query errors may be hidden'}; throw [UnauthorizedAccessException]::new('test-denied') }
$rejected=$false
try { Get-OwnedReadyEndpoint } catch { $rejected=$_.Exception.Message -eq 'test-denied' }
if(-not $rejected){throw 'A VM query failure was mislabeled as vm_not_found'}
`;
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 15000 });
  assert.equal(fs.readFileSync(path.join(root, "status.json"), "utf8"), "unchanged");
});

test("read-only VM ownership rejects a reparse-point disk in its chain", { skip: process.platform !== "win32" }, () => {
  const source = fileURLToPath(new URL("../src/plugins/io.rabiroute.manager.xiaomi-home/scripts/Install-HomeAssistantOs.ps1", import.meta.url));
  const literal = value => `'${value.replaceAll("'", "''")}'`;
  const script = `
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile(${literal(source)},[ref]$tokens,[ref]$errors)
$function=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-InstallationDisk'},$true)
Invoke-Expression $function.Extent.Text
function Test-Path { param($LiteralPath,$PathType) return $true }
function Get-Item { param($LiteralPath,[switch]$Force) return @{Attributes=[IO.FileAttributes]::ReparsePoint} }
if(Test-InstallationDisk 'C:\\haos\\home-assistant.vhdx' 'C:\\haos\\home-assistant.vhdx' $true){throw 'Reparse-point disk accepted'}
`;
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 15000 });
});

test("HA readiness requires an HA response and never follows redirects", { skip: process.platform !== "win32" }, async t => {
  let mode = "valid";
  const server = http.createServer((request, response) => {
    if (mode === "redirect") { response.writeHead(302, { location: "http://127.0.0.1:1/" }); response.end(); return; }
    if (request.url === "/api/") { response.writeHead(401); response.end(); return; }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ name: mode === "valid" ? "Home Assistant" : "Other" }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const source = fileURLToPath(new URL("../src/plugins/io.rabiroute.manager.xiaomi-home/scripts/Install-HomeAssistantOs.ps1", import.meta.url));
  const script = `
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile('${source.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)
$function=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-HomeAssistantCore'},$true)
Invoke-Expression $function.Extent.Text
if(Test-HomeAssistantCore '127.0.0.1' ${server.address().port}) { 'ready' } else { 'not-ready' }
`;
  const check = async () => (await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 15000 })).stdout.trim();
  assert.equal(await check(), "ready");
  mode = "other"; assert.equal(await check(), "not-ready");
  mode = "redirect"; assert.equal(await check(), "not-ready");
});

test("legacy credential migration preserves historical VM ownership after DHCP and requires the exact old mapping", { skip: process.platform !== "win32" }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "haos-legacy-binding-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = fileURLToPath(new URL("../src/plugins/io.rabiroute.manager.xiaomi-home/scripts/Install-HomeAssistantOs.ps1", import.meta.url));
  fs.writeFileSync(path.join(root, "loopback-proxy.json"), JSON.stringify({ address: "192.0.2.1", port: 80, vmId: "test-vm" }));
  const script = `
$ErrorActionPreference='Stop'; $tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile('${source.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)
$function=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-OwnedLegacyLoopback'},$true)
Invoke-Expression $function.Extent.Text
$Root='${root.replaceAll("'", "''")}'; $script:mapping='192.0.2.1/80'
function Get-ItemProperty { param($LiteralPath,$ErrorAction) return @{'127.0.0.1/8123'=$script:mapping} }
$script:addresses=@('192.0.2.1')
function Get-VMNetworkAdapter { param($VM) return @{IPAddresses=$script:addresses} }
if(-not (Test-OwnedLegacyLoopback @{Id='test-vm'})){throw 'Matching receipt rejected'}
if(Test-OwnedLegacyLoopback @{Id='foreign-vm'}){throw 'Foreign VM accepted'}
$script:addresses=@('192.0.2.2')
if(-not (Test-OwnedLegacyLoopback @{Id='test-vm'})){throw 'DHCP discarded historical forwarding ownership'}
$script:addresses=@('192.0.2.1')
$script:mapping='192.0.2.2/80'
if(Test-OwnedLegacyLoopback @{Id='test-vm'}){throw 'Changed mapping accepted'}
$script:mapping='192.0.2.1/8123'
if(Test-OwnedLegacyLoopback @{Id='test-vm'}){throw 'Changed old port accepted'}
$script:mapping=$null
if(Test-OwnedLegacyLoopback @{Id='test-vm'}){throw 'Missing mapping accepted'}
$receiptFile=Join-Path $Root 'loopback-proxy.json'
foreach($invalid in @('localhost','127.0.0.1','0.0.0.0','169.254.1.1','224.0.0.1','::1','192.0.2.1/24','192.0.2.1 ')) {
  @{address=$invalid;port=80;vmId='test-vm'}|ConvertTo-Json|Set-Content -LiteralPath $receiptFile
  $script:mapping=$invalid+'/80'
  if(Test-OwnedLegacyLoopback @{Id='test-vm'}){throw 'Invalid historical address accepted'}
}
@{address='192.0.2.1';port=443;vmId='test-vm'}|ConvertTo-Json|Set-Content -LiteralPath $receiptFile
$script:mapping='192.0.2.1/443'
if(Test-OwnedLegacyLoopback @{Id='test-vm'}){throw 'Invalid historical port accepted'}
Set-Content -LiteralPath $receiptFile -Value '{broken'
if(Test-OwnedLegacyLoopback @{Id='test-vm'}){throw 'Malformed receipt accepted'}
@{address='192.0.2.1';port=80;vmId='test-vm'}|ConvertTo-Json|Set-Content -LiteralPath $receiptFile
$script:mapping='192.0.2.1/80'
function Get-Item {param($LiteralPath,[switch]$Force)return @{Attributes=[IO.FileAttributes]::ReparsePoint}}
if(Test-OwnedLegacyLoopback @{Id='test-vm'}){throw 'Reparse-point receipt accepted'}
Remove-Item -LiteralPath $receiptFile
if(Test-OwnedLegacyLoopback @{Id='test-vm'}){throw 'Missing receipt accepted'}
`;
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 15000 });
});

test("DHCP legacy proof follows the current owned Core and never probes the recycled old IP or trusts cached endpoints", { skip: process.platform !== "win32" }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "haos-dhcp-owned-"));
  t.after(() => { assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const vmId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  fs.writeFileSync(path.join(root, "image.json"), JSON.stringify({ endpoint: { vmId: "foreign", address: "192.0.2.99", port: 80 } }));
  const status = JSON.stringify({ endpoint: { vmId: "foreign", address: "192.0.2.99", port: 80, legacyBindingVerified: true } });
  fs.writeFileSync(path.join(root, "status.json"), status);
  fs.writeFileSync(path.join(root, "loopback-proxy.json"), JSON.stringify({ address: "192.0.2.1", port: 80, vmId }));
  const source = fileURLToPath(new URL("../src/plugins/io.rabiroute.manager.xiaomi-home/scripts/Install-HomeAssistantOs.ps1", import.meta.url));
  const literal = value => `'${value.replaceAll("'", "''")}'`;
  const script = `
$ErrorActionPreference='Stop';$tokens=$null;$errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile(${literal(source)},[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Installer syntax errors'}
foreach($name in @('Test-OwnedLegacyLoopback','Get-OwnedReadyEndpoint')) {
 $fn=$ast.Find({param($n)$n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
 Invoke-Expression $fn.Extent.Text
}
$Root=${literal(root)};$script:probes=@();$script:ownedDisk=$true;$script:coreReady=$true;$script:networkReads=0
$script:vm=@{Id='${vmId}';Notes=('RabiRoute Home Assistant OS: '+$Root);State='Running'}
function Get-VM {param($Name,$ErrorAction)return $script:vm}
function Get-VMHardDiskDrive {param($VM)return @{Path=(Join-Path $Root 'home-assistant.vhdx')}}
function Test-InstallationDisk {param($AttachedPath,$ExpectedPath,$RejectReparse)if(-not $RejectReparse){throw 'Owned observation must reject reparse'};return $script:ownedDisk}
function Get-VMNetworkAdapter {param($VM)$script:networkReads++;return @{IPAddresses=@('192.0.2.42')}}
function Get-ItemProperty {param($LiteralPath,$ErrorAction)return @{'127.0.0.1/8123'='192.0.2.1/80'}}
function Test-HomeAssistantCore {param($Address,$Port)$script:probes+=($Address+':'+$Port);if($Address -ne '192.0.2.42'){throw 'Old/recycled/cache IP was probed'};return $script:coreReady -and $Port -eq 80}
function Start-VM {throw 'Readonly observation cannot start VM'}
function Stop-VM {throw 'Readonly observation cannot stop VM'}
function Set-VM {throw 'Readonly observation cannot modify VM'}
$result=Get-OwnedReadyEndpoint
if(-not $result.ready -or -not $result.legacyBindingVerified -or $result.vmId -ne '${vmId}' -or $result.address -ne '192.0.2.42'){throw 'DHCP owner proof was not retained'}
if(($script:probes -join ',') -ne '192.0.2.42:80'){throw 'Unexpected endpoint probe'}
$script:coreReady=$false;$result=Get-OwnedReadyEndpoint
if($result.ready -or $result.ContainsKey('legacyBindingVerified')){throw 'Unready Core granted legacy proof'}
$script:coreReady=$true;$script:ownedDisk=$false;$before=$script:networkReads;$rejected=$false
try{Get-OwnedReadyEndpoint}catch{$rejected=$true}
if(-not $rejected -or $script:networkReads -ne $before){throw 'Untrusted VHD reached network discovery'}
$script:ownedDisk=$true;$script:vm.Notes='foreign';$rejected=$false
try{Get-OwnedReadyEndpoint}catch{$rejected=$true}
if(-not $rejected -or $script:networkReads -ne $before){throw 'Foreign notes reached network discovery'}
`;
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 15000 });
  assert.equal(fs.readFileSync(path.join(root, "status.json"), "utf8"), status);
});

test("Core recovery uses one graceful owned-VM restart and refuses a failed shutdown", { skip: process.platform !== "win32" }, () => {
  const source = fileURLToPath(new URL("../src/plugins/io.rabiroute.manager.xiaomi-home/scripts/Install-HomeAssistantOs.ps1", import.meta.url));
  const script = `
$ErrorActionPreference='Stop'; $tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile('${source.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Installer syntax errors'}
$function=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Restore-HomeAssistantCore'},$true)
if(-not $function){throw 'Core recovery is missing'}
Invoke-Expression $function.Extent.Text
foreach($name in @('Get-StartMemoryAdmission','Get-StartMemoryErrorCode','Start-OwnedHomeAssistantVm')) {
 $fn=$ast.Find({param($node)$node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
 Invoke-Expression $fn.Extent.Text
}
function Get-CimInstance { param($ClassName,$ErrorAction) return @{FreePhysicalMemory=4194304} }
function Set-VM { param($VM,$AutomaticStartAction,$AutomaticStopAction) }
$script:checks=0; $script:stops=0; $script:starts=0; $script:fail=$false
function Wait-HomeAssistantCore { param($Vm,$TimeoutSeconds) $script:checks++; if($script:checks -gt 1){return @{address='192.0.2.42';port=80}} }
function Stop-VM { param($VM,[switch]$AsJob) $script:stops++; return @{State='Completed'} }
function Wait-Job { param($Job,$Timeout) if($script:fail){return $null}; return $Job }
function Receive-Job { param($Job,[switch]$ErrorAction) }
function Remove-Job { param($Job) }
function Get-VM { param($Id) return @{Id=$Id;State='Off';MemoryStartup=2GB} }
function Start-VM { param($VM) $script:starts++ }
$vm=@{Id='test-vm';State='Running'}
$endpoint=Restore-HomeAssistantCore $vm $true
if($endpoint.address -ne '192.0.2.42' -or $endpoint.port -ne 80 -or $script:stops -ne 1 -or $script:starts -ne 1){throw 'Core recovery did not restart exactly once'}
$script:checks=0; $script:fail=$true
$rejected=$false
try { Restore-HomeAssistantCore $vm $true } catch { $rejected=$true }
if(-not $rejected -or $script:starts -ne 1){throw 'Failed shutdown was treated as successful'}
`;
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 15000 });
});

test("HA startup memory admission defers without starting and handles only the current Start-VM resource race", { skip: process.platform !== "win32" }, () => {
  const source=fileURLToPath(new URL("../src/plugins/io.rabiroute.manager.xiaomi-home/scripts/Install-HomeAssistantOs.ps1",import.meta.url));
  const script=`
$ErrorActionPreference='Stop';$t=$null;$e=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${source.replaceAll("'","''")}',[ref]$t,[ref]$e)
if($e.Count){throw 'PS parse errors'}
foreach($name in @('Get-StartMemoryAdmission','Get-StartMemoryErrorCode','Start-OwnedHomeAssistantVm')){
 $fn=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true);Invoke-Expression $fn.Extent.Text
}
$script:free=916436;$script:starts=0;$script:settings=0;$script:race=$false;$script:unknown=$false
function Get-CimInstance {param($ClassName,$ErrorAction)if($ClassName -ne 'Win32_OperatingSystem'){throw 'Unexpected query'};return @{FreePhysicalMemory=$script:free}}
function Set-VM {param($VM,$AutomaticStartAction,$AutomaticStopAction)$script:settings++}
function Start-VM {param($VM,$ErrorAction)$script:starts++;if($script:race){throw [ComponentModel.Win32Exception]::new(1450)};if($script:unknown){throw [UnauthorizedAccessException]::new('denied')}}
function Stop-VM {throw 'Startup cannot stop any VM'}
$vm=@{MemoryStartup=2GB;State='Off'}
$low=Start-OwnedHomeAssistantVm $vm
if($low.started -or $low.deferred.reason -ne 'host_memory' -or $low.deferred.vmStarted -or $script:starts -ne 0 -or $script:settings -ne 0){throw 'Low memory mutated VM'}
$script:free=4194304;$script:race=$true;$raced=Start-OwnedHomeAssistantVm $vm
if($raced.started -or $raced.deferred.nativeCode -ne '0x800705AA' -or $raced.deferred.vmStarted -or $script:starts -ne 1){throw 'Native resource race not deferred'}
$script:race=$false;$script:unknown=$true;$rejected=$false
try{Start-OwnedHomeAssistantVm $vm}catch{$rejected=$true}
if(-not $rejected){throw 'Unknown failure misclassified as memory wait'}
$script:unknown=$false;$ready=Start-OwnedHomeAssistantVm $vm
if(-not $ready.started -or $script:starts -ne 3){throw 'Resources returning did not allow original Start'}
`;
  execFileSync("powershell.exe",["-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(script,"utf16le").toString("base64")],{windowsHide:true,timeout:15000});
});

test("the actual automatic Start branch only observes a running VM and emits one current result", {skip:process.platform!=="win32"}, t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"haos-start-observe-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=fileURLToPath(new URL("../src/plugins/io.rabiroute.manager.xiaomi-home/scripts/Install-HomeAssistantOs.ps1",import.meta.url));
  const script=`
$ErrorActionPreference='Stop';$t=$null;$e=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${source.replaceAll("'","''")}',[ref]$t,[ref]$e)
foreach($name in @('Write-Status','Write-OperationResult','Complete-DeferredStart')){$fn=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true);Invoke-Expression $fn.Extent.Text}
$branch=$ast.Find({param($n)$n -is [Management.Automation.Language.IfStatementAst] -and $n.Extent.Text.StartsWith('if ($wasRunning -and $Operation')},$true)
if(-not $branch){throw 'Running Start observation branch missing'}
$runner=[scriptblock]::Create($branch.Extent.Text)
$Root='${root.replaceAll("'","''")}';$statusPath=Join-Path $Root 'status.json';$wasRunning=$true;$Operation='Start';$version='fixture';$vm=@{Id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'}
function Get-OwnedReadyEndpoint {if($script:ready){return @{ready=$true;address='192.0.2.42';port=80;legacyBindingVerified=$false}};return @{ready=$false}}
function Start-VM {throw 'Running automatic Start must not start VM'}
function Stop-VM {throw 'Running automatic Start must not stop VM'}
function Set-VM {throw 'Running automatic Start must not rewrite VM'}
foreach($ready in @($false,$true)){
 $script:ready=$ready;$OperationId=[guid]::NewGuid().ToString('D');$OperationStartedAt=[DateTime]::UtcNow.ToString('o');$script:ownedVmVerified=$true;$script:operationResultEmitted=$false
 & $runner
}
`;
  const stdout=execFileSync("powershell.exe",["-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(script,"utf16le").toString("base64")],{windowsHide:true,timeout:15000,encoding:"utf8"});
  const results=stdout.split(/\r?\n/).filter(l=>l.startsWith("RABIROUTE_HA_RESULT:")).map(l=>JSON.parse(l.slice("RABIROUTE_HA_RESULT:".length)));
  assert.equal(results.length,2);assert.equal(results[0].outcome,"deferred");assert.equal(results[0].deferred.vmStarted,false);assert.equal(results[0].code,"core_starting");assert.match(results[0].message,/等待 Core/);assert.equal(results[1].outcome,"ready");assert.notEqual(results[0].operationId,results[1].operationId);
});


test("unapproved background recovery fails without changing status or requesting elevation", { skip: process.platform !== "win32" }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "haos-recovery-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const status = JSON.stringify({ state: "installed", message: "test-only-existing-state" });
  fs.writeFileSync(path.join(root, "status.json"), status);
  const source = fileURLToPath(new URL("../src/plugins/io.rabiroute.manager.xiaomi-home/scripts/Install-HomeAssistantOs.ps1", import.meta.url));
  await assert.rejects(promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", source,
    "-Operation", "Recover", "-Root", root, "-AutoStart", "yes"], { windowsHide: true, timeout: 15000, cwd: process.env.SystemRoot }), /Administrator approval is required at Rabi Host startup/);
  assert.equal(fs.readFileSync(path.join(root, "status.json"), "utf8"), status);
});

test("HA OS ownership accepts its checkpoint chain and rejects foreign or cyclic disks", { skip: process.platform !== "win32" }, () => {
  const source = fileURLToPath(new URL("../src/plugins/io.rabiroute.manager.xiaomi-home/scripts/Install-HomeAssistantOs.ps1", import.meta.url));
  const script = `
$ErrorActionPreference = 'Stop'
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile('${source.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)
$function=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-InstallationDisk'},$true)
Invoke-Expression $function.Extent.Text
function Get-VHD($Path) { @{ ParentPath = $parents[$Path] } }
$parents=@{'C:\\haos\\checkpoint.avhdx'='C:\\haos\\home-assistant.vhdx';'C:\\haos\\cycle.avhdx'='C:\\haos\\cycle.avhdx';'C:\\haos\\foreign.avhdx'='C:\\other\\base.vhdx'}
$base='C:\\haos\\home-assistant.vhdx'
if(-not (Test-InstallationDisk $base $base)){throw 'Base disk rejected'}
if(-not (Test-InstallationDisk 'C:\\haos\\checkpoint.avhdx' $base)){throw 'Owned checkpoint rejected'}
if(Test-InstallationDisk 'C:\\haos\\cycle.avhdx' $base){throw 'Cycle accepted'}
if(Test-InstallationDisk 'C:\\haos\\foreign.avhdx' $base){throw 'Foreign disk accepted'}
if(Test-InstallationDisk 'C:\\other\\checkpoint.avhdx' $base){throw 'External checkpoint accepted'}
`;
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true });
});

test("Windows PowerShell can atomically replace HA OS progress more than once", { skip: process.platform !== "win32" }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "haos-status-test-"));
  t.after(() => {
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const source = fileURLToPath(new URL("../src/plugins/io.rabiroute.manager.xiaomi-home/scripts/Install-HomeAssistantOs.ps1", import.meta.url));
  const literal = value => `'${value.replaceAll("'", "''")}'`;
  const script = `
$ErrorActionPreference = 'Stop'
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile(${literal(source)},[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Installer syntax errors'}
$function=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Write-Status'},$true)
Invoke-Expression $function.Extent.Text
$Root=${literal(root)}
$statusPath=Join-Path $Root 'status.json'
Write-Status 'installing' 'first'
Write-Status 'installing' 'second'
Write-Status 'reboot_required' 'third'
`;
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true });
  const result = JSON.parse(fs.readFileSync(path.join(root, "status.json"), "utf8"));
  assert.equal(result.state, "reboot_required");
  assert.equal(result.message, "third");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "status.previous.json"), "utf8")).message, "second");
});

test("HA OS download reports actual bytes and rejects truncated responses", { skip: process.platform !== "win32" }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "haos-download-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = http.createServer((request, response) => {
    response.writeHead(200);
    response.write(Buffer.alloc(1024));
    setTimeout(() => {
      response.write(Buffer.alloc(1024));
      setTimeout(() => response.end(request.url === "/short" ? undefined : Buffer.alloc(1024)), 600);
    }, 600);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const source = fileURLToPath(new URL("../src/plugins/io.rabiroute.manager.xiaomi-home/scripts/Install-HomeAssistantOs.ps1", import.meta.url));
  const literal = value => `'${value.replaceAll("'", "''")}'`;
  const script = `
$ErrorActionPreference='Stop'
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile(${literal(source)},[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Installer syntax errors'}
foreach($name in @('Write-Status','Save-ImageDownload')) {
  $function=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
  Invoke-Expression $function.Extent.Text
}
$Root=${literal(root)}
$statusPath=Join-Path $Root 'status.json'
Save-ImageDownload 'http://127.0.0.1:${server.address().port}/full' (Join-Path $Root 'download.zip') 3072 'test'
Copy-Item -LiteralPath $statusPath -Destination (Join-Path $Root 'complete.json')
$rejected=$false
try { Save-ImageDownload 'http://127.0.0.1:${server.address().port}/short' (Join-Path $Root 'short.zip') 3072 'test' }
catch { $rejected=$true }
if(-not $rejected){throw 'Truncated response accepted'}
`;
  await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 15000 });
  const complete = JSON.parse(fs.readFileSync(path.join(root, "complete.json"), "utf8"));
  assert.deepEqual(complete.progress, { phase: "download", percent: 100, completedBytes: 3072, totalBytes: 3072 });
  const incomplete = JSON.parse(fs.readFileSync(path.join(root, "status.json"), "utf8"));
  assert.equal(incomplete.progress.completedBytes, 2048);
  assert.equal(incomplete.progress.percent, 66);
  assert.equal(fs.statSync(path.join(root, "download.zip")).size, 3072);
});
