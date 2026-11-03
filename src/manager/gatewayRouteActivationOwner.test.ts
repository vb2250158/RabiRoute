import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import test from "node:test";
import { bindGatewayRouteSnapshotReceiver } from "../runtime/gatewayRouteSnapshotReceiver.js";
import { GATEWAY_ROUTE_SNAPSHOT_ACK_PREFIX, GatewayRouteSnapshotApplyRejected, gatewayRouteSnapshotRevision } from "../shared/gatewayRouteSnapshot.js";
import { createGatewayRouteActivationOwner, type GatewayRouteActivationRuntime } from "./gatewayRouteActivationOwner.js";

const boot = { id: "route", gatewayPort: 8790, enabled: true, webhookPath: "/before", groupNotificationTemplate: "shared" };
const identity = { gatewayId: boot.id, gatewayGenerationId: "generation", pid: 42 };
function fixture(apply: () => Promise<void>, timeoutMs = 50, unavailableInstances: readonly string[] = []) {
  const input = new PassThrough(), output = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin: input, stdout: output, pid: 42, exitCode: null, signalCode: null }) as unknown as ChildProcess;
  let drop = false;
  const acknowledgements: unknown[] = [];
  const published = new Writable({ write(bytes, _encoding, callback) {
    acknowledgements.push(JSON.parse(bytes.toString().slice(GATEWAY_ROUTE_SNAPSHOT_ACK_PREFIX.length)));
    if (!drop) output.write(bytes);
    callback();
  } });
  const receiver = bindGatewayRouteSnapshotReceiver({ identity, initialRevision: gatewayRouteSnapshotRevision(boot), input, output: published, applySnapshot: apply, unavailableInstances: () => unavailableInstances });
  const owner = createGatewayRouteActivationOwner({ timeoutMs, declarations: async () => [{ endpointType: "webhook", routeKeys: ["webhookPath"], runtimeFields: { webhookPath: { paths: ["webhookPath"] } } }] });
  owner.attach(child, identity, boot, gatewayRouteSnapshotRevision(boot));
  const runtime: GatewayRouteActivationRuntime = { definition: { ...boot, webhookPath: "/after" }, process: child, needsRestart: true, readiness: "ready" };
  return { owner, runtime, acknowledgements, drop(value: boolean) { drop = value; },
    async dispose() { owner.detach(child); await receiver.dispose(); input.destroy(); output.destroy(); published.destroy(); }
  };
}

test("catalog application awaits the exact resident ACK and retains a separate committed-operation activation receipt", async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(async () => gate, 500);
  t.after(() => f.dispose());
  const pending = f.owner.prepare([f.runtime], "original-catalog-operation");
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.owner.receipt("original-catalog-operation"), undefined);
  assert.equal(f.runtime.needsRestart, false);
  release();
  const result = await pending;
  assert.equal(result.state, "applied");
  assert.equal(result.gateways[0]?.revision, gatewayRouteSnapshotRevision(f.runtime.definition));
  assert.equal(result.gateways[0]?.operationId, "original-catalog-operation");
});

test("shared and unknown fields keep real restart while endpoint changes compare against the last child ACK", async t => {
  let applied = 0;
  const f = fixture(async () => { applied++; });
  t.after(() => f.dispose());
  await f.owner.prepare([f.runtime], "endpoint-update");
  f.runtime.definition = { ...f.runtime.definition, groupNotificationTemplate: "new shared pipeline" };
  f.runtime.needsRestart = true;
  const result = await f.owner.prepare([f.runtime], "shared-update");
  assert.equal(result.state, "requested");
  assert.equal(f.runtime.needsRestart, true);
  assert.equal(applied, 1);
});

test("a lost ACK is recovered by the original catalog ID without applying a newer draft", async t => {
  let applied = 0;
  const f = fixture(async () => { applied++; });
  t.after(() => f.dispose());
  f.drop(true);
  assert.equal((await f.owner.prepare([f.runtime], "original")).state, "uncertain");
  const submittedRevision = gatewayRouteSnapshotRevision(f.runtime.definition);
  f.runtime.definition = { ...f.runtime.definition, groupNotificationTemplate: "new desired shared data", webhookPath: "/new-draft" };
  f.drop(false);
  const result = await f.owner.prepare([f.runtime], "original", true);
  assert.equal(result.state, "applied");
  assert.equal(result.gateways[0]?.revision, submittedRevision);
  assert.equal(applied, 1);
});

test("known native rejection is not replayed by progress/final capture and leaves unrelated Route consumers alive", async t => {
  let applied = 0;
  const f = fixture(async () => { applied++; throw new GatewayRouteSnapshotApplyRejected("Old owner remains published"); });
  t.after(() => f.dispose());
  assert.equal((await f.owner.prepare([f.runtime], "rejected")).state, "rejected");
  assert.equal((await f.owner.prepare([f.runtime], "rejected")).state, "rejected");
  assert.equal((await f.owner.prepare([f.runtime], "watch-capture", false, false)).state, "rejected");
  assert.equal(f.owner.receipt("watch-capture"), undefined, "background captures do not retain user mutation receipts");
  assert.equal(applied, 1);
  assert.equal(f.runtime.process?.pid, 42);
  assert.equal(f.runtime.needsRestart, false);
  await f.owner.prepare([f.runtime], "explicit-new-save");
  assert.equal(applied, 2);
});

test("a later catalog operation blocked by an unconfirmed prior operation reports its own no-work rejection", async t => {
  const f = fixture(async () => {});
  t.after(() => f.dispose());
  f.drop(true);
  await f.owner.prepare([f.runtime], "first");
  f.runtime.definition = { ...f.runtime.definition, webhookPath: "/next" };
  const result = await f.owner.prepare([f.runtime], "second");
  assert.equal(result.state, "rejected");
  assert.equal(result.gateways[0]?.blockedByOperationId, "first");
});

test("an unavailable unrelated endpoint is a warning and does not reject a successful changed-owner ACK", async t => {
  const f = fixture(async () => {}, 50, ["endpoint:wecom"]);
  t.after(() => f.dispose());
  const result = await f.owner.prepare([f.runtime], "webhook-update");
  assert.equal(result.state, "applied");
  assert.deepEqual(result.gateways[0]?.unavailableInstances, ["endpoint:wecom"]);
});

test("a completed original ACK cannot label a newer desired endpoint document as applied", async t => {
  let applied = 0;
  const f = fixture(async () => { applied++; });
  t.after(() => f.dispose());
  await f.owner.prepare([f.runtime], "original");
  f.runtime.definition = { ...f.runtime.definition, webhookPath: "/newer-desired" };
  const result = await f.owner.prepare([f.runtime], "original");
  assert.equal(result.state, "requested");
  assert.equal(applied, 1);
});
