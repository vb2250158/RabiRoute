import test from 'node:test';
import assert from 'node:assert/strict';
import { createRabiOperationTools } from './src/operation-tools.mjs';

const toolCall = { functionName: 'rabi_foreground_window', arguments: {} };
const sdk = {
  async describe() { assert.fail('The tool must use the native reader'); },
  async invokeOperation() { assert.fail('The tool must use the native reader'); },
};

test('foreground context is read only when called and uses the current window', async () => {
  let reads = 0;
  let title = 'Game Window';
  const backend = createRabiOperationTools({
    sdk,
    readForeground: async () => ({ available: true, title, application: 'game.exe', observedAt: ++reads }),
  });
  try {
    assert.ok(backend.tools.some(tool => tool.function.name === toolCall.functionName));
    assert.match(backend.instructions, /先调用 rabi_foreground_window/);
    assert.equal(reads, 0);
    assert.deepEqual(await backend.executeTool(toolCall), {
      ok: true, mutation: false,
      data: { available: true, title, application: 'game.exe', observedAt: 1 },
    });
    title = 'Settings';
    assert.equal((await backend.executeTool(toolCall)).data.title, title);
    await assert.rejects(backend.executeTool({ ...toolCall, arguments: { target: 'another-pc' } }), /FOREGROUND_WINDOW_INPUT_INVALID/);
    assert.equal(reads, 2);
  } finally {
    await backend.dispose();
  }
});

test('failed observation does not disclose native errors and unsupported hosts omit the tool', async () => {
  const backend = createRabiOperationTools({ sdk, readForeground: async () => { throw Error('Private native error'); } });
  const unsupported = createRabiOperationTools({ sdk, readForeground: null });
  try {
    assert.deepEqual(await backend.executeTool(toolCall), {
      ok: false, mutation: false, error: 'FOREGROUND_WINDOW_UNAVAILABLE',
    });
    assert.ok(!unsupported.tools.some(tool => tool.function.name === toolCall.functionName));
    await assert.rejects(unsupported.executeTool(toolCall), /FOREGROUND_WINDOW_UNAVAILABLE/);
  } finally {
    await backend.dispose();
    await unsupported.dispose();
  }
});
