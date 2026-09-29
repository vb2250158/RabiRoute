import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { resolveAgentRuntimeMode, usesRemoteAgent, agentTurnDestination } from '../utils/agent-runtime-mode.js';
const source = await fs.readFile(new URL('../pages/home/index.ink', import.meta.url), 'utf8');
for (const token of ['', 'standalone', 'mobile-bound', 'real-device-credential']) {
  assert.equal(agentTurnDestination(resolveAgentRuntimeMode(), token), 'local');
  assert.equal(agentTurnDestination(resolveAgentRuntimeMode('transcription'), token), 'local');
}
assert.equal(agentTurnDestination('legacy-remote-observer', 'real-device-credential'), 'remote');
assert.equal(agentTurnDestination('legacy-remote-observer', ''), 'unavailable');
assert.match(source, /this.agentRuntimeMode = resolveAgentRuntimeMode\(query.agentRuntimeMode\)/);
const branch = source.slice(source.indexOf('    if (destination === "local")'), source.indexOf('\n  async simulateStreamOutput'));
const body = branch.slice(0, branch.lastIndexOf('\n  },'));
for (const [destination, localExpected, remoteExpected] of [['local', 1, 0], ['remote', 0, 1], ['unavailable', 0, 0]]) {
  let local = 0, remote = 0;
  vm.runInNewContext(`(function(){${body}}).call(page)`, { destination, finalUserText: 'test', page: { executeLingzhuAgentPrompt(){local++;}, flushTranscriptQueue(){remote++;}, setData(){} } });
  assert.equal(local, localExpected); assert.equal(remote, remoteExpected);
}
for (const signature of ['async flushTranscriptQueue()', 'scheduleAgentPoll(delayMs = 80)', 'drainAgentMessageQueue()', 'async pollAgentMessages(generation = this.agentPollGeneration)', 'async requestConversationReview(reason = "touchpad")']) {
  const start = source.indexOf(`  ${signature} {`);
  assert.ok(start >= 0);
  assert.match(source.slice(start, start + signature.length + 130), /if \(!usesRemoteAgent\(this.agentRuntimeMode\)\)/);
}
assert.equal(usesRemoteAgent(undefined), false);
assert.equal((source.match(/class="releaseVersion"/g) || []).length, 1);
console.log('Agent runtime owner: defaults, credentials, mutually exclusive dispatch and remote guards passed.');
