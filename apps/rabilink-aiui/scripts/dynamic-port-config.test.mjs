import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import {
  createDefaultGateway, duplicateSelectedGateway, normalizeNapcatInstance,
  createDefaultNapcatInstance
} from '../utils/config-surface.js';

const app = path.resolve(import.meta.dirname, '..');
let pagePromise;
function loadPage() {
  return pagePromise ??= (async () => {
    const source = fs.readFileSync(path.join(app, 'pages/home/index.ink'), 'utf8');
    const script = source.match(/<script setup>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    const result = await build({ stdin: { contents: script, resolveDir: path.join(app, 'pages/home'), loader: 'js' },
      bundle: true, write: false, platform: 'node', format: 'cjs', plugins: [{name:'device-runtime-stub',setup(builder) {
        builder.onResolve({filter:/^wx$/}, () => ({path:'wx',namespace:'device-runtime-stub'}));
        builder.onLoad({filter:/.*/,namespace:'device-runtime-stub'}, () => ({contents:'export default {};',loader:'js'}));
      }}] });
    const module = {exports:{}};
    new Function('module','exports','require',result.outputFiles[0].text)(module,module.exports,createRequire(import.meta.url));
    return module.exports.default;
  })();
}

test('new routes and NapCat instances request automatic listeners without inventing upstream URLs', () => {
  const gateway = createDefaultGateway(2);
  assert.equal(gateway.gatewayPort, 0);
  assert.equal(gateway.napcatHttpUrl, '');
  const instance = createDefaultNapcatInstance(gateway);
  assert.equal(instance.gatewayPort, 0);
  assert.equal(instance.httpUrl, '');
  assert.equal(instance.webuiUrl, '');
});

test('NapCat normalization preserves explicit zero and explicit upstream URLs', () => {
  const normalized = normalizeNapcatInstance({gatewayPort:0,httpUrl:'http://192.0.2.5:43210',webuiUrl:''}, 0,
    {gatewayPort:8789,napcatHttpUrl:'http://127.0.0.1:3000',napcatWebuiUrl:'http://127.0.0.1:6099/webui'});
  assert.equal(normalized.gatewayPort,0);
  assert.equal(normalized.httpUrl,'http://192.0.2.5:43210');
  assert.equal(normalized.webuiUrl,'');
  assert.equal(normalizeNapcatInstance({gatewayPort:43210}).gatewayPort,43210);
  for(const port of [-1,65536,1.5]) assert.throws(()=>normalizeNapcatInstance({gatewayPort:port}));
});

test('duplicating routes does not copy an occupied nested WS listener', () => {
  const original={...createDefaultGateway(1),gatewayPort:43210,napcatInstances:[{id:'default',gatewayPort:43210,httpUrl:'http://192.0.2.8:44321'}]};
  const duplicate=duplicateSelectedGateway([original],0).gateway;
  assert.equal(duplicate.gatewayPort,0);
  assert.equal(duplicate.napcatInstances[0].gatewayPort,0);
  assert.equal(duplicate.napcatInstances[0].httpUrl,original.napcatInstances[0].httpUrl);
  assert.equal(original.gatewayPort,43210);
});

test('actual page input handlers preserve zero and distinguish a cleared field', async () => {
  const page=await loadPage();
  const inputs = [['onGatewayPortInput','gatewayPort'],['onWebhookPortInput','webhookPort'],['onRabiLinkPortInput','rabiLinkWebhookPort']];
  if (typeof page.onFenneNotePortInput === 'function') inputs.push(['onFenneNotePortInput','fenneNoteWebhookPort']);
  for(const [name,key] of inputs) {
    assert.equal(typeof page[name], 'function', name);
    let patch;
    page[name].call({patchGateway:value=>{patch=value;}},{detail:{value:'0'}});
    assert.equal(patch[key],0,name);
    page[name].call({patchGateway:value=>{patch=value;}},{detail:{value:''}});
    assert.equal(patch[key],'',name);
  }
});

test('actual NapCat API body preserves instance zero and omits unconfigured upstream URLs', async () => {
  const page=await loadPage();
  const body=page.napcatWebguiBody.call({selectedGatewayConfig:()=>({id:'route-a',gatewayPort:43210}),
    selectedNapcatDraft:()=>({id:'default',gatewayPort:0,httpUrl:'',webuiUrl:''})});
  assert.equal(body.gatewayId,'route-a');assert.equal(body.instanceId,'default');assert.equal(body.gatewayPort,0);
  const wire=JSON.parse(JSON.stringify(body));
  assert.equal('httpUrl' in wire,false);assert.equal('webuiUrl' in wire,false);
});

test('actual NapCat API body retains a user-configured external upstream', async () => {
  const page=await loadPage();
  const body=page.napcatWebguiBody.call({selectedGatewayConfig:()=>({id:'route-a'}),
    selectedNapcatDraft:()=>({id:'external',gatewayPort:43210,httpUrl:'http://192.0.2.8:44321',webuiUrl:'http://192.0.2.8:44322/webui'})});
  assert.equal(body.httpUrl,'http://192.0.2.8:44321');assert.equal(body.webuiUrl,'http://192.0.2.8:44322/webui');
});
