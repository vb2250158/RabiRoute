import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeRegistry } from './runtimeRegistry.js';
import type { GatewayDefinition } from '../shared/gatewayConfigModel.js';
import { GatewayDiagnosticsSnapshotService } from './gatewayDiagnosticsSnapshot.js';
import { readGatewayDiagnosticsStatuses, type GatewayDiagnosticsReadFailure } from './gatewayDiagnosticsRead.js';

function runtimes() {
  const registry = new RuntimeRegistry();
  for (const id of ['first', 'middle', 'last']) registry.set({ id, name: id, enabled: true, agentRoleId: 'example', messageAdapterType: 'webhook' } as GatewayDefinition, { readiness: 'ready' });
  return new Map(registry.keys().map(id => [id, registry.get(id)!]));
}
function owner() {
  return new GatewayDiagnosticsSnapshotService({
    capture: () => ({ runtimes: [], personaPresentations: [] }),
    initialSnapshot: { diagnostics: [{ id: 'first', running: false, customEvidence: 'cached-first' }, { id: 'last', customEvidence: 'cached-last' }], summary: [], refreshedAt: '2026-10-31T00:00:00Z' },
    load: async () => { throw new Error('worker unavailable'); }
  });
}

test('one snapshot and one refresh serve the batch; live facts override cached business fields', () => {
  const service = owner(); service.stop();
  let reads = 0, refreshes = 0;
  const result = readGatewayDiagnosticsStatuses(process.cwd(), runtimes(), {
    requestRefresh: () => { refreshes++; }, read: include => { reads++; return service.read(include); }
  });
  assert.equal(reads, 1); assert.equal(refreshes, 1);
  assert.deepEqual(result.map(row => row.id), ['first', 'middle', 'last']);
  assert.equal(result[0]!.customEvidence, 'cached-first');
  assert.equal(result[0]!.running, true); assert.equal(result[0]!.lifecycleState, 'ready');
  assert.equal(result[2]!.customEvidence, 'cached-last');
});

test('a damaged middle runtime remains identifiable without failing healthy neighbors and recovers', () => {
  const service = owner(); service.stop();
  const rows = runtimes();
  const middle = rows.get('middle')!;
  const original = middle.definition;
  // Model a broken projection while retaining the registry's authoritative ID.
  middle.definition = undefined as unknown as GatewayDefinition;
  const failures: GatewayDiagnosticsReadFailure[] = [];
  const result = readGatewayDiagnosticsStatuses(process.cwd(), rows, service, failure => failures.push(failure));
  assert.equal(result[0]!.running, true); assert.equal(result[2]!.running, true);
  assert.equal(result[1]!.id, 'middle'); assert.ok(result[1]!.diagnosticsUnavailable);
  assert.equal('running' in result[1]!, false); assert.equal('lifecycleState' in result[1]!, false);
  assert.equal(failures.length, 1); assert.equal(failures[0]!.gatewayId, 'middle');
  middle.definition = original;
  assert.equal(readGatewayDiagnosticsStatuses(process.cwd(), rows, service)[1]!.running, true);
});

test('snapshot-owner failure preserves independent live runtime facts and scopes the missing enhancement', () => {
  const failures: GatewayDiagnosticsReadFailure[] = [];
  const result = readGatewayDiagnosticsStatuses(process.cwd(), runtimes(), {
    requestRefresh: () => { throw new Error('refresh owner unavailable'); },
    read: () => { throw new Error('cache unavailable'); }
  }, failure => failures.push(failure));
  assert.equal(result.length, 3);
  for (const row of result) {
    assert.equal(row.running, true);
    assert.deepEqual(row.diagnosticsUnavailable, { code: 'GATEWAY_DIAGNOSTICS_SNAPSHOT_UNAVAILABLE', scope: 'cached-diagnostics' });
    assert.equal('customEvidence' in row, false);
  }
  assert.deepEqual(failures.map(item => item.stage), ['refresh', 'snapshot']);
});

test('failed background refresh retains committed evidence and optional logger failure cannot hide rows', async () => {
  const service = owner();
  await service.refresh({ force: true }); service.stop();
  const rows = runtimes();
  rows.get('middle')!.definition = undefined as unknown as GatewayDefinition;
  const result = readGatewayDiagnosticsStatuses(process.cwd(), rows, service, () => { throw new Error('optional logger failed'); });
  assert.equal(result[0]!.customEvidence, 'cached-first');
  assert.equal(result[0]!.running, true);
  assert.equal((result[0]!.diagnosticsUnavailable as { code: string }).code, 'GATEWAY_DIAGNOSTICS_REFRESH_FAILED');
  assert.equal(result[2]!.customEvidence, 'cached-last');
  assert.equal(result[1]!.id, 'middle');
});
