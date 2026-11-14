import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));

const originalRequire = createRequire(path.join(root, 'package.json'));
const { parse, compileScript, compileTemplate } = originalRequire('@vue/compiler-sfc');
const { transformSync } = originalRequire('esbuild');
const vue = originalRequire('vue');
const computer = path.join(root, 'src/plugins/io.rabiroute.manager.core/web/computer');

test('display and native-region observation preserve coordinates and legacy capture', async () => {
for (const name of ['ComputerControlObservation.vue', 'ComputerControlRow.vue']) {
  const filename = path.join(computer, name);
  const { descriptor, errors } = parse(fs.readFileSync(filename, 'utf8'));
  assert.deepEqual(errors, [], name);
  const script = compileScript(descriptor, { id: name });
  const template = compileTemplate({
    source: descriptor.template.content,
    filename,
    id: name,
    compilerOptions: { bindingMetadata: script.bindings }
  });
  assert.deepEqual(template.errors, [], name);
}

function observation(supportsDisplays) {
  const filename = path.join(computer, 'ComputerControlObservation.vue');
  const descriptor = parse(fs.readFileSync(filename, 'utf8')).descriptor;
  const source = transformSync(compileScript(descriptor, { id: 'observation' }).content,
    { loader: 'ts', format: 'cjs' }).code;
  const module = { exports: {} };
  const schema = { anyOf: [{ properties: {
    action: { const: 'screen.capture' },
    maxWidth: { type: 'number' },
    ...(supportsDisplays ? { scope: { enum: ['display', 'region', 'window', 'virtual'] } } : {})
  } }] };
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    require(name) {
      if (name === 'vue') return vue;
      if (name.endsWith('/i18n/index')) return { useI18n: () => ({ t: text => text }) };
      if (name === '@shared/agentInteractiveProtocol') return { computerRequestSchema: schema };
      if (name.endsWith('.vue')) return {};
      return originalRequire(name);
    }
  });
  const events = [];
  const props = vue.reactive({
    windows: [{ windowId: 'abc', pid: 42, title: 'Fixture' }],
    capabilities: ['screenshots', 'windows'],
    displays: [
      { displayId: 'left', name: 'Left', primary: true, nativeBounds: { x: -1600, y: 0, width: 1600, height: 900 } },
      { displayId: 'right', name: 'Right', primary: false, nativeBounds: { x: 0, y: 0, width: 2560, height: 1440 } }
    ],
    foregroundDisplayId: 'right',
    layoutRevision: 'layout-1',
    disabled: false
  });
  const scope = vue.effectScope();
  const model = scope.run(() => module.exports.default.setup(props, {
    expose() {}, emit(name, body) { events.push({ name, body }); }
  }));
  return { props, model, events, close: () => scope.stop() };
}

const current = observation(true);
try {
  assert.equal(current.events.length, 0, 'opening settings must not capture');
  assert.equal(current.model.selectedDisplay.value, 'right', 'prefer foreground display');
  current.model.capture();
  assert.equal(current.events.at(-1).body.scope, 'display');
  assert.equal(current.events.at(-1).body.displayId, 'right');
  current.model.source.value = 'desktop';
  current.model.capture();
  assert.equal(Object.hasOwn(current.events.at(-1).body, 'scope'), false, 'new bundle preserves old-node desktop entry');
  current.model.source.value = 'region';
  Object.assign(current.model.region, { x: 20, y: 30, width: 500, height: 300 });
  current.model.parameters.value = { maxWidth: 320 };
  await vue.nextTick();
  current.model.capture();
  const region = current.events.at(-1).body;
  assert.equal(region.scope, 'region');
  assert.equal(region.region.width, 500);
  assert.equal(Object.hasOwn(region, 'maxWidth'), false, 'region keeps native default');
  current.model.region.width = 9999;
  const submitted = current.events.filter(item => item.name === 'submit').length;
  current.model.capture();
  assert.equal(current.events.filter(item => item.name === 'submit').length, submitted);
  current.model.source.value = 'window';
  current.model.selectedWindow.value = 'abc';
  current.model.capture();
  assert.equal(current.events.at(-1).body.pid, 42);
  current.props.layoutRevision = 'layout-2';
  await vue.nextTick();
  assert.ok(current.events.some(item => item.name === 'source-change'));
} finally { current.close(); }

const legacy = observation(false);
try {
  assert.equal(legacy.model.source.value, 'desktop');
  legacy.model.capture();
  assert.equal(Object.hasOwn(legacy.events.at(-1).body, 'scope'), false);
  assert.equal(legacy.events.at(-1).body.action, 'screen.capture');
} finally { legacy.close(); }


});
