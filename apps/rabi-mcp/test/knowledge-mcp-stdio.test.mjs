import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// SDK 1.30.1 does not expose raw stdout or exit codes. Instrument its spawned
// process in this test only; all protocol framing and requests remain SDK-owned.
class ObservedStdioTransport extends StdioClientTransport {
  stdout = '';
  exit = null;
  async start() {
    const started = super.start();
    const child = this._process;
    assert.ok(child, 'SDK must expose the pinned-version subprocess for evidence');
    child.stdout.on('data', chunk => { this.stdout += chunk.toString('utf8'); });
    this.exit = once(child, 'close');
    await started;
  }
}

test('official stdio SDK initializes, lists, calls and exits cleanly with protocol-only stdout', { timeout: 10000 }, async t => {
  const transport = new ObservedStdioTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('./knowledge-mcp-stdio-fixture.mjs', import.meta.url))],
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    stderr: 'pipe'
  });
  const client = new Client({ name: 'knowledge-stdio-test', version: '1.0.0' });
  const protocolErrors = [];
  let stderr = '';
  transport.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  client.onerror = error => protocolErrors.push(error);
  t.after(async () => { await client.close(); });
  await client.connect(transport);
  assert.equal(client.getServerVersion().name, 'rabi-knowledge');
  const catalog = await client.listTools();
  assert.ok(catalog.tools.some(tool => tool.name === 'knowledge_search'));
  assert.ok(!catalog.tools.some(tool => tool.name === 'plan_create'));
  const result = await client.callTool({ name: 'knowledge_search', arguments: { roleId: 'fixture-role', query: 'fixture' } });
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.ok, true);
  assert.deepEqual(result.structuredContent.data.items, [{ id: 'fixture-plan', title: 'Fixture only' }]);
  const denied = await client.callTool({ name: 'knowledge_search', arguments: { roleId: 'not-allowed' } });
  assert.equal(denied.isError, true);
  await client.close();
  const [exitCode, signal] = await transport.exit;
  assert.equal(exitCode, 0, 'server must exit normally, not via SDK kill fallback');
  assert.equal(signal, null);
  assert.equal(stderr, '');
  assert.deepEqual(protocolErrors, []);
  assert.ok(transport.stdout.endsWith('\n'));
  const lines = transport.stdout.trimEnd().split('\n');
  assert.ok(lines.length >= 4, 'initialize, list and both calls must produce protocol responses');
  for (const line of lines) {
    const frame = JSON.parse(line);
    assert.equal(frame.jsonrpc, '2.0');
    assert.ok(Object.hasOwn(frame, 'id'));
    assert.ok(Object.hasOwn(frame, 'result') || Object.hasOwn(frame, 'error'));
  }
});
