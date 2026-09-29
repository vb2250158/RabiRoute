import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
test('actual grant editor injection preserves native fetch receiver', async () => {
  const source=fs.readFileSync(new URL('./rabilink-relay-server.mjs',import.meta.url),'utf8');
  const line=source.split('\n').find(x=>x.includes('const editor = createKnowledgeGrantEditor({'));
  assert(line);
  let calls=0;
  const context={state:{},document:{},apiBase:'/manage/api',headers:()=>({}),sessionStorage:{},pendingProfileWrites:new Set(),crypto:{randomUUID:()=> 'fixture'},createKnowledgeGrantEditor:env=>{env.fetch('/fixture');return {};},fetch:function(url){assert.equal(this,undefined,'unbound native fetch must not receive the editor environment');assert.equal(url,'/fixture');calls++;}};
  vm.runInNewContext(line,context);assert.equal(calls,1);
  assert.throws(()=>{const bad={fetch:context.fetch};bad.fetch('/fixture');},/unbound native fetch/);
});
