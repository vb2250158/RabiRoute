import test from 'node:test';
import assert from 'node:assert/strict';
import { installWebRuntime, checkWebRuntime } from '../src/webRuntime';

test('candidate dependencies accept needed exports without exact library version or unrelated export requirements', () => {
  const ref = () => 1;
  installWebRuntime({ vue: { ref }, service: { read: () => 2 } });
  assert.doesNotThrow(() => checkWebRuntime({ abi: 'rabi-web-runtime/1', imports: [{ id: 'vue', exports: ['ref'] }] }));
  assert.throws(() => checkWebRuntime({ abi: 'rabi-web-runtime/1', imports: [{ id: 'vue', exports: ['newExport'] }] }), /newExport/);
  assert.doesNotThrow(() => checkWebRuntime({ abi: 'rabi-web-runtime/1', imports: [{ id: 'service', exports: ['read'] }] }));
});
