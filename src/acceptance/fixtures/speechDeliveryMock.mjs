import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mock } from 'node:test';

// Explicit test-only preload. Never remove NODE_TEST_CONTEXT or weaken the
// production adapter guard to make a child process reach a real host.
assert.ok(process.env.NODE_TEST_CONTEXT, 'Speech delivery mock requires a Node test child.');
const adapterUrl = new URL('../../agentAdapters/agentAdapter.ts', import.meta.url);
const original = await import(adapterUrl.href);
mock.module(adapterUrl.href, {
  namedExports: {
    ...original,
    createAgentAdapter: async (provider, target) => {
      assert.equal(provider, 'marvis');
      assert.equal(target, 'local');
      return {
        type: provider,
        deliver: async envelope => {
          assert.ok(envelope.messageContent.trim());
          assert.equal(envelope.messageSource.type, 'message_adapter');
          assert.ok(['speech', 'rabilink'].includes(envelope.messageSource.messageAdapter));
          const receipt = { provider, messageAdapter: envelope.messageSource.messageAdapter };
          const line = JSON.stringify(receipt) + '\n';
          if (process.env.RABI_SPEECH_TEST_RECEIPT_FILE) fs.appendFileSync(process.env.RABI_SPEECH_TEST_RECEIPT_FILE, line);
          process.stdout.write('RABI_SPEECH_TEST_DELIVERY ' + line);
        }
      };
    }
  }
});
