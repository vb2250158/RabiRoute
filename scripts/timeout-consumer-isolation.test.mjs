import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const implementations = [
  'scripts/lib/timeout-settings.mjs',
  'plugin-adapters/remote-agent-rabiroute/timeout-settings.mjs',
  'plugins/rabi-codex-context/scripts/lib/timeout-settings.mjs',
  'plugins/rabi-antigravity-context/scripts/lib/timeout-settings.mjs',
  'plugins/rabi-workbuddy-context/scripts/lib/timeout-settings.mjs',
  'plugins/rabi-dsh-context/timeout-settings.mjs'
];
for (const filename of implementations) test(`${filename}: malformed preferences retain independent valid timeouts`, async t => {
  const warnings = [];
  t.mock.method(process, 'emitWarning', message => warnings.push(String(message)));
  const owner = await import(new URL('../' + filename, import.meta.url));
  owner.configureTimeouts({ valid: 1250, broken: 0 });
  assert.equal(owner.getTimeoutMs('valid', 50, {}), 1250);
  assert.equal(owner.getTimeoutMs('broken', 50, {}), 50);
  assert.ok(warnings.some(message => message.includes('broken')));
  const damaged = { RABIROUTE_TIMEOUT_OVERRIDES: '{damaged' };
  assert.equal(owner.getTimeoutMs('valid', 50, damaged), 1250);
  assert.equal(owner.getTimeoutMs('missing', 50, damaged), 50);
  const count = warnings.length;
  owner.getTimeoutMs('missing', 50, damaged);
  assert.equal(warnings.length, count, 'repeated reads do not repeat the same diagnostic');
  owner.configureTimeouts(undefined);
  assert.equal(owner.getTimeoutMs('valid', 50, { RABIROUTE_TIMEOUT_OVERRIDES: '{"broken":false,"valid":700}' }), 700);
  assert.equal(owner.getTimeoutMs('broken', 50, { RABIROUTE_TIMEOUT_OVERRIDES: '{"broken":false,"valid":700}' }), 50);
  const supplied = { valid: 19 };
  owner.configureTimeouts(supplied); supplied.valid = 900;
  assert.equal(owner.getTimeoutMs('valid', 50, {}), 19, 'owner keeps a validated snapshot');
  owner.configureTimeouts(undefined);
  assert.equal(owner.getTimeoutMs('valid', 50, {}), 50);
});

test('standalone distributions preserve the source timeout consumer contract', async () => {
  const source = await fs.readFile(new URL('../' + implementations[0], import.meta.url), 'utf8');
  for (const filename of implementations.slice(1)) assert.equal(await fs.readFile(new URL('../' + filename, import.meta.url), 'utf8'), source);
});
