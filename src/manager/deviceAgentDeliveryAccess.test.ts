import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { deviceAgentDeliveryPrincipal, type DeviceAgentDeliveryAccessOptions } from './deviceAgentDeliveryAccess.js';

test('enabled callers share the API without workspace, Route or persona bindings', () => {
  let enabled = true;
  const options: DeviceAgentDeliveryAccessOptions = { ownerInstanceId: () => 'pc-a', authorize: () => enabled ? { scope: 'application-a', sourceDeviceId: 'caller-a', deviceOwner: false } : null };
  for (const remoteAddress of ['127.0.0.1', '192.0.2.1']) {
    const request = { headers: {}, socket: { remoteAddress } } as unknown as IncomingMessage;
    assert.deepEqual(deviceAgentDeliveryPrincipal(request, 'eye-a', options), { scope: 'application-a', sourceDeviceId: 'caller-a', deviceOwner: false });
    assert.ok(deviceAgentDeliveryPrincipal(request, 'eye-b', options));
  }
  enabled = false;
  assert.equal(deviceAgentDeliveryPrincipal({ headers: {} } as IncomingMessage, 'eye-a', options), null);
});

test('the optional instance fence checks the target and never grants authority', () => {
  const options: DeviceAgentDeliveryAccessOptions = { ownerInstanceId: () => 'pc-a', authorize: () => ({ scope: 'application-a', sourceDeviceId: 'caller-a', deviceOwner: true }) };
  assert.ok(deviceAgentDeliveryPrincipal({ headers: { 'x-rabi-device-agent-instance': 'pc-a' } } as unknown as IncomingMessage, 'eye-a', options));
  assert.equal(deviceAgentDeliveryPrincipal({ headers: { 'x-rabi-device-agent-instance': 'pc-b' } } as unknown as IncomingMessage, 'eye-a', options), null);
  assert.equal(deviceAgentDeliveryPrincipal({ headers: {} } as IncomingMessage, '../eye-a', options), null);
  assert.equal(deviceAgentDeliveryPrincipal({ headers: { 'x-rabi-device-agent-route': 'some-route' } } as unknown as IncomingMessage, 'eye-a', { ...options, authorize: () => null }), null);
});
