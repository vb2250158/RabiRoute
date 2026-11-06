import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const run=promisify(execFile);
test('Web sync replaces only its wrapper and preserves the native package artifact bytes',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'web-wrapper-owner-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const source=path.join(root,'src/plugins/io.test.feature'),web=path.join(root,'dist/plugins/packages/io.test.feature/1.2.3/web');
 await fs.mkdir(source,{recursive:true});await fs.mkdir(web,{recursive:true});await fs.mkdir(path.join(root,'ribiwebgui/dist/.vite'),{recursive:true});
 await fs.writeFile(path.join(source,'rabi.plugin.json'),JSON.stringify({schemaVersion:2,id:'io.test.feature',version:'1.2.3'}));
 await fs.writeFile(path.join(source,'package.json'),JSON.stringify({rabi:{webSource:'web/index.ts'}}));
 const original=Buffer.from('native package source bytes\r\n');await fs.writeFile(path.join(web,'retained.vue'),original);
 for(const name of ['one','two']){
  await fs.writeFile(path.join(root,'ribiwebgui/dist/.vite/manifest.json'),JSON.stringify({'../src/plugins/io.test.feature/web/index.ts':{file:`assets/plugin-${name}.js`}}));
  await run(process.execPath,[fileURLToPath(new URL('./sync-plugin-web-bundles.mjs',import.meta.url))],{cwd:root,windowsHide:true});
  assert.deepEqual(await fs.readFile(path.join(web,'retained.vue')),original);
  assert.equal(await fs.readFile(path.join(web,'client.mjs'),'utf8'),`export { activate } from "/assets/plugin-${name}.js";\n`);
 }
});
