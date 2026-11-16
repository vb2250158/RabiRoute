import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {setTimeout as delay} from 'node:timers/promises';
import {startStandalone} from '../src/main.mjs';import {openSettingsStore} from '../src/settings-store.mjs';

test('the web command owner clears a previous model error while keeping stale-session protection',{skip:process.platform!=='win32'},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'assistant-command-context-'));let fail=true,app;
 const model=createServer((_req,res)=>{if(fail){res.writeHead(500);res.end();return}res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta:{content:'可以继续了。'}}]})+'\n\ndata: [DONE]\n\n')});await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
 try{await(await openSettingsStore(directory)).save({llmModel:'fixture',llmEndpoint:'http://127.0.0.1:'+model.address().port+'/v1/chat/completions',captionsEnabled:false});
  app=await startStandalone({directory,publicDirectory:'.',deviceFactory:async()=>{throw Error('UNEXPECTED_AUDIO')}});const u=new URL(app.url),headers={authorization:'Bearer '+u.hash.slice(1),'content-type':'application/json'};
  const cmd=async body=>{const r=await fetch(u.origin+'/api/command',{method:'POST',headers,body:JSON.stringify(body)});return{status:r.status,data:await r.json()}};
  const until=async check=>{for(let i=0;i<200;i++){const s=await app.state();if(check(s))return s;await delay(5)}throw Error('COMMAND_TEST_TIMEOUT')};
  const id=(await app.state()).sessionId;await cmd({action:'text',requestId:'first',sessionId:id,text:'第一次'});await until(s=>s.activity.pending===0&&s.error==='ASSISTANT_MODEL_HTTP_500');
  fail=false;await cmd({action:'text',requestId:'second',sessionId:id,text:'第二次'});await until(s=>s.activity.pending===0&&s.activity.status==='completed'&&s.error===null);
  assert.equal((await cmd({action:'clear-context',sessionId:id,confirm:true})).status,200);assert.equal((await cmd({action:'text',requestId:'stale',sessionId:id,text:'旧页面'})).data.error,'ASSISTANT_CONTEXT_CHANGED');
 }finally{await app?.dispose();await new Promise(resolve=>model.close(resolve));await rm(directory,{recursive:true,force:true})}
});
