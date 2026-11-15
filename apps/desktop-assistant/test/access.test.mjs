import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {openAccessToken} from '../src/access-store.mjs';import {createBrowserAccess} from '../ui/browser-access.mjs';import {openAssistantServer} from '../src/server.mjs';
const storage=()=>{const values=new Map();return {getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)}};

test('local capability persists encrypted, is reused at restart, and rejects malformed credentials',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'assistant-access-'));try{
  const token=await openAccessToken(dir);assert.equal(token.length,43);assert.equal(await openAccessToken(dir),token);assert.ok(!(await readFile(join(dir,'access.json'),'utf8')).includes(token));
  const fakeHost={state:async()=>({alive:true}),dispose:async()=>{}};
  let server=await openAssistantServer({host:fakeHost,messages:()=>[],directory:'.',accessToken:token});const port=Number(new URL(server.origin).port);await server.close();
  server=await openAssistantServer({host:fakeHost,messages:()=>[],directory:'.',port,accessToken:await openAccessToken(dir)});try{
   assert.equal((await fetch(server.origin+'/api/state',{headers:{Authorization:'Bearer '+token}})).status,200);
   assert.equal((await fetch(server.origin+'/api/state',{headers:{Authorization:'Bearer '+'é'.repeat(43)}})).status,401);
   assert.equal((await fetch(server.origin+'/api/state',{headers:{Authorization:'Bearer '+token,Origin:'https://example.org'}})).status,403);
   assert.equal((await fetch(server.origin+'/api/state')).status,401);
  }finally{await server.close()}
 }finally{await rm(dir,{recursive:true,force:true})}
});
test('browser remembers the exact-origin startup link across tabs and ordinary reloads',async()=>{
 const local=storage(),session=storage(),token='a'.repeat(43);let cleared=0,seen;
 const make=(hash='')=>createBrowserAccess({origin:'http://127.0.0.1:10099',hash,storage:local,session,clearHash:()=>cleared++,fetcher:async(path,opts)=>{seen={path,opts};return{ok:true,status:200,json:async()=>({alive:true})}}});
 await make('#'+token).request('state');assert.equal(cleared,1);assert.equal(seen.opts.headers.Authorization,'Bearer '+token);assert.equal(seen.opts.redirect,'error');
 assert.equal(make().hasToken(),true);make().acceptLink('http://127.0.0.1:10099/?connect=1#'+token);
 assert.throws(()=>make().acceptLink('http://127.0.0.1:10099/?redirect=other#'+token),/LINK_INVALID/);
 assert.throws(()=>make().acceptLink('http://other.invalid/#'+token),/LINK_INVALID/);
 assert.throws(()=>make().acceptLink('http://127.0.0.1:10098/#'+token),/LINK_INVALID/);
 assert.throws(()=>make().acceptLink('an-api-key'),/LINK_INVALID/);
});
test('expired access clears cached capability and requests explicit recovery',async()=>{
 const local=storage();let required=0,calls=0;const client=createBrowserAccess({origin:'http://127.0.0.1:10099',hash:'#'+'b'.repeat(43),storage:local,session:storage(),clearHash(){},onRequired:()=>required++,fetcher:async()=>{calls++;return{ok:false,status:401,json:async()=>({error:'ASSISTANT_AUTH_REQUIRED'})}}});
 await assert.rejects(client.request('state'),/AUTH_REQUIRED/);assert.equal(client.hasToken(),false);assert.equal(required,1);
 await assert.rejects(client.request('state'),/AUTH_REQUIRED/);assert.equal(calls,1);
});
