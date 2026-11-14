import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {once} from 'node:events';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const fixtureChildren=new Map();
function trackFixtureChild(service,child){fixtureChildren.get(service)?.push(child);return child;}
const quote=v=>"'"+v.replaceAll("'","''")+"'";
function powershell(command){return spawnSync('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(command+'; exit 0','utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:30000});}
async function until(read,check=v=>v,ms=25000){let last;const stop=Date.now()+ms;while(Date.now()<stop){try{last=await read();if(check(last))return last;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('Deadline: '+JSON.stringify(last));}
async function json(file){return JSON.parse(await fs.readFile(file,'utf8'));}
function alive(pid){try{process.kill(pid,0);return true;}catch{return false;}}
function owner(file,args=[]){const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',file,...args],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PORT:'8788',HOST:'0.0.0.0'}});child.output='';child.stdout.on('data',b=>child.output+=b);child.stderr.on('data',b=>child.output+=b);return trackFixtureChild(path.dirname(file),child);}
async function stop(child){if(child?.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}}
async function fixture(t,full=false){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'relay-owner-test-'));
 const files=JSON.parse(await fs.readFile(path.join(root,'scripts/rabilink-relay-runtime-files.json'),'utf8'));
 for(const file of [...files,'package.json','scripts/rabilink-relay-runtime-files.json','scripts/deploy-rabilink-relay-windows.ps1','scripts/lib/rabilink-relay-runtime-paths.ps1','scripts/lib/rabilink-relay-runtime-paths.json','scripts/lib/rabilink-relay-service.ps1']){await fs.mkdir(path.dirname(path.join(directory,file)),{recursive:true});await fs.copyFile(path.join(root,file),path.join(directory,file));}
 await fs.mkdir(path.join(directory,'node_modules'));await fs.symlink(await fs.realpath(path.join(root,'node_modules/ws')),path.join(directory,'node_modules/ws'),'junction');
 if(full){for(const file of ['ribiwebgui/dist/index.html','assets/fixture.txt','data/rabilink-relay/rokid-rabilink-plugin.CURRENT.openapi.json','data/rabilink-relay/rokid-rabilink-plugin.MANUAL_AUTH.openapi.json','data/rabilink-relay/rokid-rabilink-plugin.AGENT_TOKEN.openapi.json','examples/rabilink-relay/rabilink-speech-api.openapi.json']){await fs.mkdir(path.dirname(path.join(directory,file)),{recursive:true});await fs.writeFile(path.join(directory,file),'{}');}}
 const prepared=powershell(`$ErrorActionPreference='Stop'; & ${quote(path.join(directory,'scripts/deploy-rabilink-relay-windows.ps1'))} -PrepareOnly -ServerIp fixture.invalid -Domain fixture.invalid -RuntimeOnly:$${!full} -PublicHttpPort 18088 | ConvertTo-Json -Compress`);
 assert.equal(prepared.status,0,prepared.stderr+prepared.stdout);
 const bundle=JSON.parse(prepared.stdout.trim());
 fixtureChildren.set(bundle.BundleRoot,[]);
 t.after(async()=>{for(const child of fixtureChildren.get(bundle.BundleRoot))await stop(child);fixtureChildren.delete(bundle.BundleRoot);const cleanup=powershell(`$ErrorActionPreference='Stop';. ${quote(path.join(root,'scripts/lib/rabilink-relay-service.ps1'))};Stop-RelayServiceProcesses -Root ${quote(bundle.BundleRoot)} -Role caddy;Stop-RelayServiceProcesses -Root ${quote(bundle.BundleRoot)} -Role relay`);assert.equal(cleanup.status,0,cleanup.stderr);await fs.rm(directory,{recursive:true,force:true});await fs.rm(bundle.BundleRoot,{recursive:true,force:true});await fs.rm(bundle.BundleZip,{force:true});});
 return bundle.BundleRoot;
}
test('generated original owners use actual port with occupied legacy port, recover restart, reject stale identities and fence descendants',{skip:process.platform!=='win32',timeout:95000},async t=>{
 const occupied=net.createServer(socket=>socket.end('foreign'));occupied.listen(8788,'127.0.0.1');await once(occupied,'listening');t.after(()=>new Promise(r=>occupied.close(r)));
 const service=await fixture(t,true);let relay,caddy,oldBlocker;
 t.after(async()=>{await stop(caddy);await stop(relay);if(oldBlocker)await new Promise(r=>oldBlocker.close(r));});
 const stub=path.join(service,'caddy-fixture.mjs');
 await fs.writeFile(stub,`import fs from 'node:fs';import path from 'node:path';const config=fs.readFileSync(process.argv[process.argv.indexOf('--config')+1],'utf8');const port=Number(config.match(/reverse_proxy 127\\.0\\.0\\.1:(\\d+)/)[1]);fs.appendFileSync(path.join(process.cwd(),'logs/caddy-fixture.jsonl'),JSON.stringify({pid:process.pid,port,config})+'\\n');setInterval(()=>{},1000);`);
 relay=owner(path.join(service,'start-rabilink-relay.ps1'));
 const first=await until(()=>json(path.join(service,'logs/relay-endpoint.json')),v=>v.state==='ready').catch(e=>{throw Error(e.message+' '+relay.output)});
 assert.notEqual(first.port,8788);assert.equal(first.host,'127.0.0.1');assert(alive(first.pid),relay.output);
 const duplicate=owner(path.join(service,'start-rabilink-relay.ps1'),['-Once']);
 await until(()=>duplicate.exitCode,v=>v!==null);assert.notEqual(duplicate.exitCode,0);assert(alive(first.pid));
 caddy=owner(path.join(service,'start-caddy.ps1'),['-Executable',process.execPath,'-ArgumentPrefix',`"${stub}"`]);
 const records=async()=>((await fs.readFile(path.join(service,'logs/caddy-fixture.jsonl'),'utf8')).trim().split('\n').map(JSON.parse));
 const started=await until(records,v=>v.length===1);assert.equal(started[0].port,first.port);assert(started[0].config.includes('http://:18088'));assert(started[0].config.includes('admin off'));
 process.kill(first.pid);await until(()=>alive(first.pid),v=>!v);
 oldBlocker=net.createServer();
 await until(()=>new Promise(resolve=>{
   const failed=()=>{oldBlocker.off('listening',bound);resolve(false);};
   const bound=()=>{oldBlocker.off('error',failed);resolve(true);};
   oldBlocker.once('error',failed);oldBlocker.once('listening',bound);oldBlocker.listen(first.port,'127.0.0.1');
 }),Boolean,5000);
 const second=await until(()=>json(path.join(service,'logs/relay-endpoint.json')),v=>v.state==='ready'&&v.run!==first.run);
 assert.notEqual(second.port,first.port);assert.notEqual(second.port,8788);
 assert.equal((await (await fetch(`http://127.0.0.1:${second.port}/health`,{headers:{Connection:'close'}})).json()).ok,true);
 const recovered=await until(records,v=>v.length===2);assert.equal(recovered[1].port,second.port);await until(()=>alive(started[0].pid),v=>!v);
 // A forged/stale port cannot keep the original Caddy forwarding to a foreign listener.
 await fs.writeFile(path.join(service,'logs/relay-endpoint.json'),JSON.stringify({...second,port:8788}));
 await until(()=>alive(recovered[1].pid),v=>!v);
 await fs.writeFile(path.join(service,'logs/relay-endpoint.json'),JSON.stringify(second));
 const restored=await until(records,v=>v.length===3);assert.equal(restored[2].port,second.port);
 await stop(caddy);await until(()=>alive(restored[2].pid),v=>!v);
 caddy=owner(path.join(service,'start-caddy.ps1'),['-Executable',process.execPath,'-ArgumentPrefix',`"${stub}"`]);
 const caddyRestart=await until(records,v=>v.length===4);assert.equal(caddyRestart[3].port,second.port);
 await stop(relay);await until(()=>alive(second.pid),v=>!v);await until(()=>alive(caddyRestart[3].pid),v=>!v);
 assert(occupied.listening);assert.equal(caddy.exitCode,null,caddy.output);
 // A publication surviving an abrupt owner exit is rejected using current OS identities.
 const read=powershell(`. ${quote(path.join(service,'scripts/lib/rabilink-relay-service.ps1'))}; if(Get-RelayEndpoint ${quote(service)}){throw 'stale READY accepted'}`);assert.equal(read.status,0,read.stderr);
});

test('RuntimeOnly retains original Caddy launcher and migrates only managed routes without changing public/custom configuration',{skip:process.platform!=='win32',timeout:35000},async t=>{
 const service=await fixture(t);
 await fs.access(path.join(service,'start-caddy.ps1'));await assert.rejects(fs.access(path.join(service,'Caddyfile.template')),{code:'ENOENT'});
 const module=path.join(service,'scripts/lib/rabilink-relay-service.ps1');
 const source='{'+'\n auto_https disable_redirects\n}\nhttp://example.invalid, http://:18088 {\n handle /health {\n reverse_proxy 127.0.0.1:8788\n }\n handle /custom { reverse_proxy 127.0.0.1:5555 }\n}\n';
 const input=path.join(service,'original.txt'),output=path.join(service,'migrated.txt');await fs.writeFile(input,source);
 const convert=powershell(`$ErrorActionPreference='Stop';. ${quote(module)}; $original=Get-Content ${quote(input)} -Raw; $converted=ConvertTo-RelayCaddyTemplate $original; [IO.File]::WriteAllText(${quote(output)},$converted); foreach($invalid in @('site { handle /unknown { reverse_proxy 127.0.0.1:8788 } }', 'site { __RABILINK_RELAY_UPSTREAM__ reverse_proxy 127.0.0.1:8788 }')) {try {ConvertTo-RelayCaddyTemplate $invalid;throw 'unknown accepted'}catch{if($_.Exception.Message -eq 'unknown accepted'){throw}}}; Assert-RelayScheduledTaskRoot @{Actions=@(@{Execute='powershell.exe';Arguments='-File "${service.replaceAll("'","''")}\\start-caddy.ps1"'})} ${quote(service)} 'start-caddy.ps1'; try {Assert-RelayScheduledTaskRoot @{Actions=@(@{Execute='powershell.exe';Arguments='-File "C:\\foreign\\start-caddy.ps1"'})} ${quote(service)} 'start-caddy.ps1';throw 'foreign task accepted'}catch{if($_.Exception.Message -eq 'foreign task accepted'){throw}}`);
 assert.equal(convert.status,0,convert.stderr);const migrated=await fs.readFile(output,'utf8');assert.equal(await fs.readFile(input,'utf8'),source);assert(migrated.includes('http://:18088'));assert(migrated.includes('reverse_proxy 127.0.0.1:5555'));assert(migrated.includes('__RABILINK_RELAY_UPSTREAM__'));assert(migrated.includes('admin off'));
});

test('migration stops only exact service-root process handles and waits for exit',{skip:process.platform!=='win32',timeout:35000},async t=>{
 const a=await fixture(t),b=await fixture(t);const processes=[];t.after(async()=>{for(const p of processes)await stop(p);});
 for(const service of [a,b]){const child=spawn(process.execPath,[path.join(service,'scripts/rabilink-relay-server.mjs')],{cwd:service,env:{...process.env,PORT:'0',HOST:'127.0.0.1',RABILINK_RELAY_DATA_DIR:path.join(service,'data')},windowsHide:true,stdio:['ignore','pipe','pipe']});child.output='';child.stdout.on('data',v=>child.output+=v);child.stderr.on('data',v=>child.output+=v);processes.push(trackFixtureChild(service,child));}
 await until(()=>processes.every(p=>p.output.includes('RABILINK_RELAY_READY:')));
 const foreignEntry=path.join(a,'foreign-tool.mjs');await fs.writeFile(foreignEntry,"console.log('FOREIGN_READY');setInterval(()=>{},1000);");
 const foreign=spawn(process.execPath,[foreignEntry,'--input',path.join(a,'scripts/rabilink-relay-server.mjs')],{cwd:a,windowsHide:true,stdio:['ignore','pipe','pipe']});foreign.output='';foreign.stdout.on('data',v=>foreign.output+=v);processes.push(trackFixtureChild(a,foreign));await until(()=>foreign.output.includes('FOREIGN_READY'));
 const result=powershell(`$ErrorActionPreference='Stop';. ${quote(path.join(a,'scripts/lib/rabilink-relay-service.ps1'))};Stop-RelayServiceProcesses -Root ${quote(a)} -Role relay`);
 assert.equal(result.status,0,result.stderr);await until(()=>alive(processes[0].pid),v=>!v);assert(alive(processes[1].pid));assert.equal(processes[1].exitCode,null);assert(alive(foreign.pid));
});

test('task and process identity uses actual executable entry, and every equivalent local legacy upstream is migrated or rejected',{skip:process.platform!=='win32'},()=>{
 const module=path.join(root,'scripts/lib/rabilink-relay-service.ps1');
 const result=powershell(`$ErrorActionPreference='Stop';. ${quote(module)}
$root='C:\\RelayRoot';$launcher=Join-Path $root 'start-caddy.ps1';$entry=Join-Path $root 'scripts/rabilink-relay-server.mjs';$config=Join-Path $root 'Caddyfile'
Assert-RelayScheduledTaskRoot @{Actions=@(@{Execute='powershell.exe';Arguments='-NoProfile -ExecutionPolicy Bypass -File "C:\\RelayRoot\\start-caddy.ps1"'})} $root 'start-caddy.ps1'
foreach($arguments in @('-NoProfile -File "C:\\foreign\\owner.ps1" -PreviousScript "C:\\RelayRoot\\start-caddy.ps1"','-Command "& C:\\RelayRoot\\start-caddy.ps1"','-NoProfile -File "C:\\RelayRoot\\start-caddy.ps1" -Command evil','-EncodedCommand fixture -File "C:\\RelayRoot\\start-caddy.ps1"')) {
 $rejected=$false;try{Assert-RelayScheduledTaskRoot @{Actions=@(@{Execute='powershell.exe';Arguments=$arguments})} $root 'start-caddy.ps1'}catch{$rejected=$true};if(-not $rejected){throw 'foreign task entry accepted'}
}
if(Test-RelayEntryPoint 'node.exe "C:\\foreign\\tool.mjs" --input "C:\\RelayRoot\\scripts\\rabilink-relay-server.mjs"' $entry node){throw 'foreign Node input accepted'}
if(Test-RelayEntryPoint 'node.exe --eval "require(123)" --input "C:\\RelayRoot\\scripts\\rabilink-relay-server.mjs"' $entry node){throw 'Node eval accepted'}
if(Test-RelayEntryPoint 'caddy.exe run --config "C:\\foreign\\Caddyfile" --previous "C:\\RelayRoot\\Caddyfile"' $config caddy){throw 'foreign Caddy config accepted'}
if(-not (Test-RelayEntryPoint 'node.exe "C:\\RelayRoot\\scripts\\rabilink-relay-server.mjs"' $entry node)){throw 'original Node entry rejected'}
if(-not (Test-RelayEntryPoint 'caddy.exe run --config "C:\\RelayRoot\\Caddyfile"' $config caddy)){throw 'original Caddy config rejected'}
foreach($upstream in @('localhost:8788','localhost:08788','http://localhost:8788','[::1]:8788','http://[::1]:8788','127.0.0.2:8788','127.1:8788','2130706433:8788','[0:0:0:0:0:0:0:1]:8788','[::ffff:127.0.0.1]:8788','tcp/127.0.0.1:8788')) {
 $original="{\n auto_https disable_redirects\n}\nhttp://example.invalid {\n handle /health { reverse_proxy 127.0.0.1:8788 }\n handle /custom { reverse_proxy "+$upstream+" }\n}"
 $rejected=$false;try{ConvertTo-RelayCaddyTemplate $original}catch{$rejected=$true};if(-not $rejected){throw ('unknown legacy target accepted: '+$upstream)}
 $known="{\n auto_https disable_redirects\n}\nhttp://example.invalid { handle /health { reverse_proxy "+$upstream+" } }"
 $converted=ConvertTo-RelayCaddyTemplate $known;if(-not $converted.Contains('__RABILINK_RELAY_UPSTREAM__')){throw 'known equivalent target not migrated'}
}
if(-not (ConvertTo-RelayCaddyTemplate 'http://example.invalid { handle /health { reverse_proxy localhost:8788 } }').Contains('admin off')){throw 'implicit admin listener retained'}
foreach($unknown in @('reverse_proxy {$OLD_RELAY_UPSTREAM:127.0.0.1:8788}','reverse_proxy {$UNKNOWN_TARGET}','import original-upstream','reverse_proxy 127.0.0.1:8788 { transport http }','reverse_proxy 127.0.0.1:54321')) {
 $content="{\n auto_https disable_redirects\n}\nhttp://fixture.invalid {\n handle /health {\n "+$unknown+"\n }\n handle /manage* {\n reverse_proxy 127.0.0.1:8788\n }\n}"
 $rejected=$false;try{ConvertTo-RelayCaddyTemplate $content}catch{$rejected=$true};if(-not $rejected){throw 'unknown managed upstream was partially migrated'}
}
foreach($content in @('http://fixture.invalid { handle /health { reverse_proxy __RABILINK_RELAY_UPSTREAM__ } handle /custom { reverse_proxy {$OLD_RELAY_UPSTREAM:localhost:8788} } }', "import routes.caddy\nhttp://fixture.invalid { handle /health { reverse_proxy 127.0.0.1:8788 } }")) {
 $rejected=$false;try{ConvertTo-RelayCaddyTemplate $content}catch{$rejected=$true};if(-not $rejected){throw 'unknown imported or environment legacy upstream was accepted'}
}
foreach($header in @('handle "/health"','\u0060handle\u0060 \u0060/health\u0060')) {
 $content='http://fixture.invalid { '+$header+' { reverse_proxy 127.0.0.1:54321 } handle /manage* { reverse_proxy 127.0.0.1:8788 } }'
 $rejected=$false;try{ConvertTo-RelayCaddyTemplate $content}catch{$rejected=$true};if(-not $rejected){throw 'unknown quoted managed upstream was accepted'}
}
foreach($header in @('handle "/health"','handle {$HEALTH_PATH}')) {
 $content='http://fixture.invalid { '+$header+' { reverse_proxy {$OLD_RELAY_UPSTREAM} } handle /manage* { reverse_proxy 127.0.0.1:8788 } }'
 $rejected=$false;try{ConvertTo-RelayCaddyTemplate $content}catch{$rejected=$true};if(-not $rejected){throw 'unknown environment-managed route was accepted'}
}
`);
 assert.equal(result.status,0,result.stderr+result.stdout);
});
