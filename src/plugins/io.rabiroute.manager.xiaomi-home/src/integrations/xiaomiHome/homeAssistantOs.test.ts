import assert from "node:assert/strict";
import test from "node:test";
import { completeManagedHaOperation, parseManagedHaEndpoint, parseManagedHaObservation, parseManagedHaObservationStatus, parseManagedHaOperation } from "./homeAssistantOs.js";

test("managed endpoint is accepted only as one complete privileged-child receipt", () => {
  const receipt = { address: "192.168.1.21", port: 80, vmId: "00000000-0000-0000-0000-000000000001", legacyBindingVerified: true };
  const line = `RABIROUTE_HA_ENDPOINT:${JSON.stringify(receipt)}`;
  assert.deepEqual(parseManagedHaEndpoint(`diagnostic\n${line}\n`), receipt);
  assert.throws(() => parseManagedHaEndpoint(""), /missing or ambiguous/);
  assert.throws(() => parseManagedHaEndpoint(`${line}\n${line}`), /missing or ambiguous/);
  for (const bad of [{ ...receipt, port: 443 }, { ...receipt, address: "example.com" }, { ...receipt, vmId: "other" }, { ...receipt, legacyBindingVerified: "true" }]) {
    assert.throws(() => parseManagedHaEndpoint(`RABIROUTE_HA_ENDPOINT:${JSON.stringify(bad)}`), /invalid/);
  }
});

test("read-only observation accepts only a complete trusted ready receipt or an explicit unavailable result", () => {
  const endpoint = { address: "192.168.1.21", port: 80, vmId: "00000000-0000-0000-0000-000000000001", legacyBindingVerified: true };
  const ready = `RABIROUTE_HA_OBSERVATION:${JSON.stringify({ ready: true, ...endpoint })}`;
  assert.deepEqual(parseManagedHaObservation(ready), endpoint);
  assert.equal(parseManagedHaObservation('RABIROUTE_HA_OBSERVATION:{"ready":false}'), undefined);
  assert.throws(() => parseManagedHaObservation(`${ready}\n${ready}`), /ambiguous/);
  assert.throws(() => parseManagedHaObservation('RABIROUTE_HA_OBSERVATION:{"ready":false,"address":"127.0.0.1"}'), /invalid/);
  assert.throws(() => parseManagedHaObservation('RABIROUTE_HA_OBSERVATION:{"ready":true,"port":80}'), /invalid/);
});

test("read-only diagnostic receipts remain separate from verified endpoints", () => {
  const diagnostics = { checkedAt: "2026-11-07T16:00:00.000Z", reason: "core_unready", vmState: "Running", guestAddresses: ["192.0.2.42"] };
  const wire = (data: unknown) => "RABIROUTE_HA_OBSERVATION:" + JSON.stringify(data);
  const unavailable = wire({ready:false, diagnostics});
  assert.equal(parseManagedHaObservation(unavailable), undefined);
  assert.deepEqual(parseManagedHaObservationStatus(unavailable).diagnostics, diagnostics);
  for (const changed of [
    { ...diagnostics, reason: "ready" }, { ...diagnostics, checkedAt: "invalid" },
    { ...diagnostics, guestAddresses: ["example.com"] }, { ...diagnostics, guestAddresses: Array(9).fill("192.0.2.42") },
    { ...diagnostics, vmState: "Running\nsecret" }, { ...diagnostics, token: "forbidden" }
  ]) assert.throws(() => parseManagedHaObservationStatus(wire({ready:false, diagnostics:changed})), /invalid/);
  assert.throws(() => parseManagedHaObservationStatus(wire({ready:false, diagnostics, address:"192.0.2.42"})), /invalid/);
  assert.throws(() => parseManagedHaObservationStatus(wire({ready:true, diagnostics:{...diagnostics,reason:"ready"}})), /invalid/);
});

const operation = { operationId: "11111111-1111-4111-8111-111111111111", action: "Start" as const, startedAt: new Date().toISOString() };
const memoryResult = () => ({ schemaVersion: 1, ...operation, completedAt: new Date().toISOString(), installed: true, outcome: "deferred", code: "host_memory_wait", message: "等待2048MB内存；0x800705AA", deferred: { reason: "host_memory", vmStarted: false, requiredMemoryBytes: 2147483648, availableMemoryBytes: 916436 * 1024, nativeCode: "0x800705AA" } });
const wireResult = (value: unknown) => `RABIROUTE_HA_RESULT:${JSON.stringify(value)}`;

test("only the current child's exact final result classifies resource waits and errors", () => {
  const status = parseManagedHaOperation(wireResult(memoryResult()), operation);
  assert.equal(status.deferred?.reason, "host_memory");
  assert.match(status.message, /0x800705AA/);
  for (const changed of [
    { ...memoryResult(), operationId: "old-status-operation" }, { ...memoryResult(), startedAt: "2000-01-01T00:00:00Z" },
    { ...memoryResult(), action: "Recover" }, { ...memoryResult(), completedAt: "2000-01-01T00:00:00Z" },
    { ...memoryResult(), completedAt: "2999-01-01T00:00:00Z" }, { ...memoryResult(), code: "unknown" },
    { ...memoryResult(), deferred: { ...memoryResult().deferred, vmStarted: true } },
    { ...memoryResult(), outcome: "failed" }
  ]) assert.throws(() => parseManagedHaOperation(wireResult(changed), operation), /invalid|Unexpected/);
  assert.throws(() => parseManagedHaOperation("old global status only", operation), /missing/);
  assert.throws(() => parseManagedHaOperation(wireResult(memoryResult()) + "\n" + wireResult(memoryResult()), operation), /ambiguous/);
  const { deferred: _deferred, ...failed } = memoryResult();
  const error = parseManagedHaOperation(wireResult({ ...failed, outcome: "failed", code: "operation_failed" }), operation);
  assert.equal(error.state, "error"); assert.equal(error.deferred, undefined); assert.match(error.message, /2048MB/);
});

test("nonzero, cancelled and late completions cannot turn an old status into deferred", async () => {
  const stdout = wireResult(memoryResult());
  await assert.rejects(completeManagedHaOperation(async () => { throw Object.assign(new Error("nonzero child"), { stdout }); }, operation), /nonzero/);
  const before = new AbortController(); before.abort(); let runs = 0;
  await assert.rejects(completeManagedHaOperation(async () => { runs++; return { stdout }; }, operation, before.signal));
  assert.equal(runs, 0);
  const during = new AbortController();
  await assert.rejects(completeManagedHaOperation(async () => { during.abort(); return { stdout }; }, operation, during.signal));
});
