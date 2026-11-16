import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isPublicPluginSource,isPluginRuntimeSource} from '../../../plugins/contracts/plugin-sdk/public-source.mjs';

const repository=fileURLToPath(new URL('../../../',import.meta.url));
const plugin='src/plugins/io.rabiroute.manager.voice-assistant';

function assertRuntimeInput(source) {
  const absolute=path.resolve(repository,source),relative=path.relative(repository,absolute).replaceAll('\\','/');
  assert.ok(!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('../'),'Project resource must remain in the source tree');
  assert.ok(isPluginRuntimeSource(relative),'Test fixtures and private data must not be runtime inputs: '+relative);
  return absolute;
}

test('assistant runtime declarations exclude test fixtures and private inputs',async()=>{
  const specification=JSON.parse(await fs.readFile(path.join(repository,plugin,'manager-runtime.build.json'),'utf8'));
  const inputs=[...specification.exports.map(item=>item.source),...Object.values(specification.aliases),...specification.resources.map(item=>item.source)];
  for(const source of inputs) {
    // Third-party native dependencies have their own package/license checks.
    if(source.replaceAll('\\','/').startsWith('node_modules/'))continue;
    await fs.access(assertRuntimeInput(source));
  }
});

test('public test media can stay in Git without becoming runtime assets or private data',()=>{
  for(const file of ['test/fixtures/synthetic.wav','test/fixtures/transcript.json','test/fixtures/protocol-input.mjs']) {
    assert.equal(isPublicPluginSource(file),true);
    assert.equal(isPluginRuntimeSource(file),false);
    assert.throws(()=>assertRuntimeInput('apps/desktop-assistant/'+file),/Test fixtures and private data/);
  }
  assert.equal(isPublicPluginSource('assets/public-ui-sound.wav'),true);
  assert.equal(isPluginRuntimeSource('assets/public-ui-sound.wav'),true);
  assert.equal(isPublicPluginSource('data/voice-assistant/test-private/input.wav'),false);
  assert.throws(()=>assertRuntimeInput('data/voice-assistant/test-private/input.wav'),/Test fixtures and private data/);
});
