import test from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../rabi-cli.mjs';

test('canonical CLI observes the final result using the same client as its API requests', async () => {
  const receipt = { ok: true, data: { items: [{ label: 'Available result' }] } };
  const observed = [];
  const result = await runCli(['call', 'manager.search', '--input-json', '{"query":{"q":"history"}}'], {
    client: {
      operations: { async describe() { return { operation: { contract: { transport: 'http' } } }; }, async call(operationId, input) {
        assert.equal(operationId, 'manager.search');
        assert.equal(input.query.q, 'history');
        return receipt;
      } },
      async observeCall(source, input, action) {
        observed.push({ source, input });
        return action();
      }
    }
  });
  assert.equal(result, receipt);
  assert.deepEqual(observed, [{ source: 'cli', input: { command: 'call', operationId: 'manager.search' } }]);
});

test('canonical CLI preserves the operation failure through observation', async () => {
  const failure = new Error('Connection unavailable');
  await assert.rejects(runCli(['call', 'manager.search'], { client: {
    operations: { async describe() { return { operation: { contract: { transport: 'http' } } }; }, async call() { throw failure; } },
    async observeCall(_source, _input, action) { return action(); }
  } }), error => error === failure);
});
