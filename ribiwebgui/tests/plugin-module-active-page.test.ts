import test from 'node:test';
import assert from 'node:assert/strict';
import { retainActiveWebPluginModule, sameWebPluginModuleInstances } from '../src/pluginModules';
import { registerTrustedWebPage, retainMountedTrustedWebPage, mountedTrustedWebPages, activeTrustedWebPage, setActiveTrustedWebPage, onActiveTrustedWebPageChanged } from '../src/pluginPages';
const descriptor = { id: 'bundle', pluginId: 'fixture.plugin', version: '1', rev: 'a'.repeat(64), entryPath: 'main.mjs', instances: [{instanceId:'instance'}] };
const registration = { instanceId:'instance',pluginId:'fixture.plugin',routeId:'fixture.active',rendererId:'fixture.renderer',paths:[{path:'/fixture-active',title:'Fixture'}],loader:async()=>({}) };
test('continuing active owner retains its complete bundle regardless of dirty state', () => {
  const dispose = registerTrustedWebPage(registration);setActiveTrustedWebPage(registration.routeId);
  try {
    assert.equal(retainActiveWebPluginModule(descriptor,{...descriptor,rev:'b'.repeat(64)}),true);
    assert.equal(retainActiveWebPluginModule({...descriptor,pluginId:'unrelated'},descriptor),false);
    assert.equal(retainActiveWebPluginModule(descriptor,undefined),false);
    assert.equal(retainActiveWebPluginModule({...descriptor,instances:[...descriptor.instances,{instanceId:'revoked-sibling'}]},descriptor),false);
    assert.equal(retainActiveWebPluginModule(descriptor,{...descriptor,instances:[{instanceId:'replacement'}]}),false);
    assert.equal(activeTrustedWebPage()?.instanceId,'instance');
    setActiveTrustedWebPage('');assert.equal(retainActiveWebPluginModule(descriptor,descriptor),false);
  } finally {setActiveTrustedWebPage('');dispose();}
});
test('only actual active-page changes request deferred refresh; membership remains order independent',()=>{
  let calls=0;const release=onActiveTrustedWebPageChanged(()=>calls++);
  setActiveTrustedWebPage('one');setActiveTrustedWebPage('one');setActiveTrustedWebPage('two');release();setActiveTrustedWebPage('');
  assert.equal(calls,2);assert.equal(sameWebPluginModuleInstances([{instanceId:'a'},{instanceId:'b'}],[{instanceId:'b'},{instanceId:'a'}]),true);
});

test('deactivated cached page keeps one old bundle until final mounted instance releases',()=>{
  const dispose=registerTrustedWebPage(registration);const first=retainMountedTrustedWebPage(registration.routeId),second=retainMountedTrustedWebPage(registration.routeId);
  try {
    setActiveTrustedWebPage('another-page');
    assert.equal(retainActiveWebPluginModule(descriptor,{...descriptor,rev:'b'.repeat(64)}),true);
    assert.equal(mountedTrustedWebPages().length,1);
    first();first();assert.equal(retainActiveWebPluginModule(descriptor,descriptor),true);
    second();assert.equal(retainActiveWebPluginModule(descriptor,descriptor),false);
  }finally{first();second();dispose();setActiveTrustedWebPage('');}
});
