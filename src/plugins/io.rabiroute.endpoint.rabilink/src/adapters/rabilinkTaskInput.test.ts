import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRabiLinkTaskInput } from './rabilinkTaskInput.js';

test('PC interprets opaque portable inputs while preserving protected transport identity and original body', () => {
  const raw = { id: 'forged', targetDeviceId: 'other', message: '  hello   world  ', deviceId: 'watch', deviceKind: 'WATCH', sourceTransport: 'PHONE', configurationRequested: true };
  const input = normalizeRabiLinkTaskInput({ id: 'task-original', appId: 'trusted-app', targetDeviceId: 'pc', inputFormat: 'opaque-v1', ingressPath: '/api/rabilink/devices/input', raw });
  assert.equal(input.id, 'task-original'); assert.equal(input.targetDeviceId, 'pc'); assert.equal(input.normalizedText, 'hello world');
  assert.equal(input.sourceDeviceId, 'watch'); assert.equal(input.sourceDeviceKind, 'watch'); assert.equal(input.transport, 'phone'); assert.equal(input.deliveryMode, 'observe');
  assert.equal(input.configurationRequested, true); assert.deepEqual(input.raw, raw);
  const bound = normalizeRabiLinkTaskInput({ ...input, source: { connectionDeviceId: 'authenticated-eyes' } });
  assert.equal(bound.sourceDeviceId, 'authenticated-eyes'); assert.deepEqual(bound.raw, raw);
});
test('wearable policy and route are checked by PC before recording; original samples are kept for the one ingest normalizer', () => {
  const raw = { health: { samples: [{ metric: 'heart-rate', bpm: 85 }] }, processingPolicy: 'agent', routeProfileId: 'route', deviceId: 'watch' };
  const envelope = { id: 'health-task', inputFormat: 'opaque-v1', ingressPath: '/api/rabilink/devices/input', raw };
  assert.throws(() => normalizeRabiLinkTaskInput(envelope), /FENCE_REQUIRED/);
  const input = normalizeRabiLinkTaskInput({ ...envelope, expectedWorkerFencing: true });
  assert.equal(input.type, 'wearable.health'); assert.equal(input.text, 'Wearable health observation'); assert.deepEqual(input.health, raw.health);
});
test('PC accepts original Rokid text aliases and rejects malformed payloads without issuing a turn', () => {
  const envelope = { id: 'original', inputFormat: 'opaque-v1', ingressPath: '/rokid/rabilink/input' };
  const input = normalizeRabiLinkTaskInput({ ...envelope, raw: { messages: [{ content: 'question' }], segmentId: 'segment', conversationId: 'session' } });
  assert.equal(input.text, 'question'); assert.equal(input.type, 'voice_transcript'); assert.equal(input.clientMessageId, 'segment'); assert.equal(input.sessionId, 'session');
  assert.throws(() => normalizeRabiLinkTaskInput({ ...envelope, raw: {} }), /TEXT_REQUIRED/);
});
