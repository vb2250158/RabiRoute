import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGatewayRouteSnapshotSupervisor, GatewayRouteSnapshotUncertain } from "../manager/gatewayRouteSnapshotSupervisor.js";
import {
  GATEWAY_ROUTE_SNAPSHOT_ACK_PREFIX, GATEWAY_ROUTE_SNAPSHOT_REQUEST_PREFIX, GatewayRouteSnapshotApplyRejected, gatewayRouteSnapshotRevision,
  type GatewayRouteSnapshotAck, type GatewayRouteSnapshotCommand
} from "../shared/gatewayRouteSnapshot.js";
import { bindGatewayRouteSnapshotReceiver, createGatewayRouteSnapshotReceiver } from "./gatewayRouteSnapshotReceiver.js";

const original = { id: "路由-test", gatewayPort: 8790, webhookPort: 8791, webhookPath: "/before" };
const identity = { gatewayId: original.id, gatewayGenerationId: "original-generation", pid: 1234 };
const bootRevision = gatewayRouteSnapshotRevision(original);
function operation(definition = { ...original, webhookPath: "/after" }, sequence = 1): GatewayRouteSnapshotCommand {
  return { ...identity, schemaVersion: 1, kind: "apply", operationId: `operation-${sequence}`, sequence,
    baseRevision: bootRevision, revision: gatewayRouteSnapshotRevision(definition), definition };
}
function fixture(applySnapshot: Parameters<typeof createGatewayRouteSnapshotReceiver>[0]["applySnapshot"], timeoutMs: number | (() => number) = 50) {
  const input = new PassThrough(), output = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin: input, stdout: output, pid: identity.pid, exitCode: null, signalCode: null }) as unknown as ChildProcess;
  let drop = false;
  const acks: GatewayRouteSnapshotAck[] = [];
  const published = new Writable({ write(bytes, _encoding, callback) {
    const ack = JSON.parse(bytes.toString().slice(GATEWAY_ROUTE_SNAPSHOT_ACK_PREFIX.length)) as GatewayRouteSnapshotAck;
    acks.push(ack);
    if (!drop) output.write(bytes);
    callback();
  } });
  const receiver = bindGatewayRouteSnapshotReceiver({ identity, initialRevision: bootRevision, input, output: published, applySnapshot });
  const supervisor = createGatewayRouteSnapshotSupervisor({ child, identity, initialRevision: bootRevision, initialDefinition: original, timeoutMs });
  return { child, input, output, receiver, supervisor, acks,
    drop(value: boolean) { drop = value; },
    async dispose() { supervisor.dispose(); await receiver.dispose(); input.destroy(); output.destroy(); published.destroy(); }
  };
}
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

test("supervisor sends an immutable exact-Route snapshot and acknowledges only completed native application", async t => {
  const release = gate();
  let received: Readonly<typeof original> | undefined;
  const f = fixture(async definition => { received = definition as typeof original; await release.promise; }, 500);
  t.after(async () => { release.release(); await f.dispose(); });
  const draft = { ...original, webhookPath: "/after", routeVariables: { secret: "fixture-only" } };
  const pending = f.supervisor.apply(draft);
  draft.routeVariables.secret = "newer-draft";
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(received?.webhookPath, "/after");
  assert.equal(Object.isFrozen(received), true);
  assert.equal(Object.isFrozen((received as typeof draft).routeVariables), true);
  assert.equal((received as typeof draft).routeVariables.secret, "fixture-only");
  assert.equal(f.supervisor.current().appliedRevision, bootRevision);
  release.release();
  const ack = await pending;
  assert.equal(ack.state, "applied");
  assert.equal(f.supervisor.current().appliedRevision, ack.revision);
  assert.equal(f.supervisor.current().appliedDefinition?.webhookPath, "/after");
  assert.equal(JSON.stringify(ack).includes("fixture-only"), false);
});

test("a lost acknowledgement remains uncertain and original-operation inspection never repeats application", async t => {
  let applied = 0;
  const f = fixture(async () => { applied++; });
  t.after(() => f.dispose());
  f.drop(true);
  await assert.rejects(f.supervisor.apply({ ...original, webhookPath: "/after" }), GatewayRouteSnapshotUncertain);
  const operationId = f.supervisor.current().operation!.operationId;
  assert.equal(applied, 1);
  assert.equal(f.supervisor.current().state, "uncertain");
  await assert.rejects(f.supervisor.apply({ ...original, webhookPath: "/other" }), GatewayRouteSnapshotUncertain);
  f.drop(false);
  const recovered = await f.supervisor.inspect();
  assert.equal(recovered.operationId, operationId);
  assert.equal(recovered.state, "applied");
  assert.equal(applied, 1);
});

test("each admitted wire send reads the current timeout without changing an already running timer", async t => {
  let configured = 60;
  const reads: number[] = [];
  const f = fixture(async () => {}, () => { reads.push(configured); return configured; });
  t.after(() => f.dispose());
  f.drop(true);
  const request = f.supervisor.apply({ ...original, webhookPath: "/dynamic-timeout" });
  configured = 1;
  assert.deepEqual(reads, [60]);
  await assert.rejects(request, GatewayRouteSnapshotUncertain);
  assert.deepEqual(reads, [60]);
  f.drop(false);
  assert.equal((await f.supervisor.inspect()).state, "applied");
  assert.deepEqual(reads, [60, 1]);
});

test("a callback failure after admission is uncertain, keeps its original operation and exposes no raw error", async t => {
  let applied = 0;
  const f = fixture(async () => { applied++; throw new Error("fixture-secret-must-not-leak"); });
  t.after(() => f.dispose());
  const result = await f.supervisor.apply({ ...original, webhookPath: "/after" });
  assert.equal(result.state, "uncertain");
  assert.equal(result.code, "apply_failed");
  assert.equal(JSON.stringify(result).includes("fixture-secret"), false);
  await assert.rejects(f.supervisor.apply({ ...original, webhookPath: "/other" }), GatewayRouteSnapshotUncertain);
  assert.equal((await f.supervisor.inspect()).operationId, result.operationId);
  assert.equal(applied, 1);
});

test("an acknowledgement write failure cannot erase a completed original operation", async () => {
  let writesFail = true, applied = 0;
  const acks: GatewayRouteSnapshotAck[] = [];
  const receiver = createGatewayRouteSnapshotReceiver({ identity, initialRevision: bootRevision, applySnapshot: async () => { applied++; },
    publish(ack) { if (writesFail) throw new Error("Response pipe failed"); acks.push(ack); } });
  const request = operation();
  receiver.receive(request);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(receiver.current().operation?.state, "applied");
  writesFail = false;
  receiver.receive({ ...request, kind: "status" });
  assert.equal(acks[0]?.state, "applied");
  assert.equal(applied, 1);
  await receiver.dispose();
});

test("a proven unchanged native-owner rejection preserves its baseline and permits a later distinct update", async t => {
  let rejected = true;
  const f = fixture(async () => { if (rejected) throw new GatewayRouteSnapshotApplyRejected("Original native owner was retained."); });
  t.after(() => f.dispose());
  const first = await f.supervisor.apply({ ...original, webhookPath: "/rejected" });
  assert.equal(first.state, "rejected");
  assert.equal(first.code, "apply_rejected");
  assert.equal(f.supervisor.current().appliedDefinition?.webhookPath, "/before");
  rejected = false;
  const next = await f.supervisor.apply({ ...original, webhookPath: "/accepted" });
  assert.notEqual(next.operationId, first.operationId);
  assert.equal(next.state, "applied");
  assert.equal(f.supervisor.current().appliedDefinition?.webhookPath, "/accepted");
});

test("receiver rejects wrong revisions and content before work and ignores another process generation", async () => {
  let applied = 0;
  const acks: GatewayRouteSnapshotAck[] = [];
  const receiver = createGatewayRouteSnapshotReceiver({ identity, initialRevision: bootRevision, applySnapshot: async () => { applied++; }, publish: ack => acks.push(ack) });
  receiver.receive({ ...operation(), gatewayGenerationId: "stale-generation" });
  assert.equal(acks.length, 0);
  receiver.receive({ ...operation(), baseRevision: "0".repeat(64) });
  assert.equal(acks.at(-1)?.code, "revision_mismatch");
  const next = operation({ ...original, webhookPath: "/after" }, 2);
  receiver.receive({ ...next, kind: "apply", definition: { ...original, webhookPath: "/tampered" } });
  assert.equal(acks.at(-1)?.code, "snapshot_invalid");
  assert.equal(applied, 0);
  await receiver.dispose();
});

test("receiver disposal closes admission and joins an accepted native transition", async () => {
  const release = gate();
  let applied = 0, ended = false;
  const acks: GatewayRouteSnapshotAck[] = [];
  const receiver = createGatewayRouteSnapshotReceiver({ identity, initialRevision: bootRevision,
    applySnapshot: async () => { applied++; await release.promise; }, publish: ack => acks.push(ack) });
  receiver.receive(operation());
  await new Promise<void>(resolve => setImmediate(resolve));
  const stopping = receiver.dispose().then(() => { ended = true; });
  receiver.receive(operation({ ...original, webhookPath: "/other" }, 2));
  assert.equal(applied, 1);
  assert.equal(ended, false);
  release.release();
  await stopping;
  assert.equal(acks.length, 0);
});

test("UTF-8 split requests and stale acknowledgements retain the original process and operation identity", async t => {
  const release = gate();
  const f = fixture(async () => release.promise, 500);
  t.after(async () => { release.release(); await f.dispose(); });
  const pending = f.supervisor.apply({ ...original, webhookPath: "/路径" });
  await new Promise<void>(resolve => setImmediate(resolve));
  const request = f.supervisor.current().operation!;
  f.output.write(GATEWAY_ROUTE_SNAPSHOT_ACK_PREFIX + JSON.stringify({ ...request, kind: "ack", state: "applied", appliedRevision: request.revision, gatewayGenerationId: "another-process" }) + "\n");
  assert.equal(f.supervisor.current().appliedRevision, bootRevision);
  release.release();
  assert.equal((await pending).state, "applied");
  const ack = f.acks.at(-1)!;
  const frame = Buffer.from(GATEWAY_ROUTE_SNAPSHOT_ACK_PREFIX + JSON.stringify(ack) + "\n");
  for (const byte of frame) f.output.write(Buffer.from([byte]));
  assert.equal(f.supervisor.current().acknowledgement?.operationId, request.operationId);
  const next = { ...original, webhookPath: "/下一条路径" };
  const splitRequest: GatewayRouteSnapshotCommand = { ...identity, schemaVersion: 1, kind: "apply", operationId: "split-operation",
    sequence: request.sequence + 1, baseRevision: request.revision, revision: gatewayRouteSnapshotRevision(next), definition: next };
  for (const byte of Buffer.from(GATEWAY_ROUTE_SNAPSHOT_REQUEST_PREFIX + JSON.stringify(splitRequest) + "\n")) f.input.write(Buffer.from([byte]));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.receiver.current().revision, splitRequest.revision);
});

test("real resident process applies two Route revisions through its inherited pipes without changing PID", { timeout: 30_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-route-wire-"));
  const effects = path.join(root, "effects.jsonl");
  const receiverUrl = new URL("./gatewayRouteSnapshotReceiver.ts", import.meta.url).href;
  const script = `import {bindGatewayRouteSnapshotReceiver} from ${JSON.stringify(receiverUrl)};
    import fs from 'node:fs';
    bindGatewayRouteSnapshotReceiver({identity:{gatewayId:process.env.TEST_ROUTE_ID,gatewayGenerationId:'real-generation',pid:process.pid},initialRevision:process.env.TEST_ROUTE_REVISION,input:process.stdin,output:process.stdout,
      async applySnapshot(definition,revision){fs.appendFileSync(process.env.TEST_ROUTE_EFFECTS,JSON.stringify({id:definition.id,path:definition.webhookPath,revision,frozen:Object.isFrozen(definition)})+'\\n');}});`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, TEST_ROUTE_ID: original.id, TEST_ROUTE_REVISION: bootRevision, TEST_ROUTE_EFFECTS: effects }
  });
  let stderr = ""; child.stderr.on("data", data => { stderr += data.toString(); });
  const supervisor = createGatewayRouteSnapshotSupervisor({ child, identity: { gatewayId: original.id, gatewayGenerationId: "real-generation", pid: child.pid! }, initialRevision: bootRevision, timeoutMs: 10_000 });
  t.after(async () => { supervisor.dispose(); const exited = once(child, "exit"); child.kill(); if (child.exitCode === null && child.signalCode === null) await exited; await fs.rm(root, { recursive: true, force: true }); });
  const first = await supervisor.apply({ ...original, webhookPath: "/first" });
  const second = await supervisor.apply({ ...original, webhookPath: "/second" });
  assert.equal(first.state, "applied", stderr);
  assert.equal(second.state, "applied", stderr);
  assert.equal(second.baseRevision, first.revision);
  assert.equal(child.pid, first.pid);
  const rows = (await fs.readFile(effects, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => row.path), ["/first", "/second"]);
  assert.equal(rows.every(row => row.frozen), true);
  assert.equal(stderr, "");
});
