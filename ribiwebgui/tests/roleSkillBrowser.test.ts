import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc';

test('skill browser compiles and renders untrusted bodies as text with no mutation controls', () => {
  const file = new URL('../src/components/RoleSkillBrowser.vue', import.meta.url);
  const source = fs.readFileSync(file, 'utf8');
  const { descriptor, errors } = parse(source);
  assert.deepEqual(errors, []);
  const script = compileScript(descriptor, { id: 'role-skill-browser' });
  const template = compileTemplate({ source: descriptor.template!.content, filename: file.pathname, id: 'role-skill-browser', compilerOptions: { bindingMetadata: script.bindings } });
  assert.deepEqual(template.errors, []);
  assert.match(template.code, /toDisplayString[^\n]*state.detail.content/);
  assert.doesNotMatch(source, /v-html|innerHTML|localStorage|setInterval/);
  assert.match(source, /onBeforeUnmount\(browser.dispose\)/);
  assert.match(source, /white-space: pre-wrap/);
  assert.match(source, /overflow-wrap: anywhere/);
});
