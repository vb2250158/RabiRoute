import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireStorageMutationCommitAdmission, StorageMutationAdmissionError } from "./managerStorageMutationAdmission.js";
import { ManagerStorageMutationPool, ManagerStorageMutationError, type ManagerStorageMutationChild } from "./managerStorageMutationPool.js";
import {
  MANAGER_STORAGE_MUTATION_PROTOCOL_VERSION,
  MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE,
  type ManagerStorageMutationRequest,
  type ManagerStorageMutationAdmission,
  type ManagerStorageMutationResponse
} from "./managerStorageMutationProtocol.js";
import { readDurableDeliveryReceipt } from "./durableDeliveryIdempotency.js";
import { readPlanStoragePackage } from "../planStorageRepository.js";

function request(): ManagerStorageMutationRequest {
  return {
    protocolVersion: MANAGER_STORAGE_MUTATION_PROTOCOL_VERSION,
    requestId: "admission-request",
    admissionNonce: "a".repeat(64),
    fence: { applicationGenerationId: "generation", managerInstanceId: "manager", storageGenerationLease: "lease", roleId: "FixtureRole", planId: "fixture-plan" },
    expectedRevision: null,
    task: { type: "plan_create", input: { title: "Admission fixture" } }
  };
}

function admission(value: ManagerStorageMutationRequest): ManagerStorageMutationAdmission {
  assert.ok(value.admissionNonce);
  return { protocolVersion: value.protocolVersion, requestId: value.requestId, fence: value.fence,
    admissionNonce: value.admissionNonce, kind: "authorization_request", stage: "commit_admission", sequence: 1 };
}

class AdmissionTransport extends EventEmitter {
  connected = true;
  readonly sent: unknown[] = [];
  sendError?: Error;
  throwSend = false;
  send(message: unknown, callback: (error: Error | null) => void): boolean {
    this.sent.push(message);
    if (this.throwSend) throw new Error("transport fixture failed");
    callback(this.sendError ?? null);
    return true;
  }
}

function assertListenersReleased(transport: AdmissionTransport): void {
  assert.equal(transport.listenerCount("message"), 0);
  assert.equal(transport.listenerCount("disconnect"), 0);
}

test("worker requires an exact admission decision and releases listeners on allow", async () => {
  const transport = new AdmissionTransport();
  const value = request();
  const waiting = acquireStorageMutationCommitAdmission(value, transport);
  assert.deepEqual(transport.sent, [admission(value)]);
  transport.emit("message", { ...admission(value), kind: "authorization_decision", allowed: true });
  await waiting;
  assertListenersReleased(transport);
  // Duplicate decisions after settlement cannot reopen the operation.
  transport.emit("message", { ...admission(value), kind: "authorization_decision", allowed: false });
  assertListenersReleased(transport);
});

const corruptions: Record<string, (value: Record<string, unknown>) => unknown> = {
  denial: value => ({ ...value, allowed: false }),
  "truthy non-boolean": value => ({ ...value, allowed: "true" }),
  "protocol version": value => ({ ...value, protocolVersion: 1 }),
  "request id": value => ({ ...value, requestId: "other-request" }),
  "dispatch nonce": value => ({ ...value, admissionNonce: "b".repeat(64) }),
  stage: value => ({ ...value, stage: "other_stage" }),
  sequence: value => ({ ...value, sequence: 2 }),
  "message kind": value => ({ ...value, kind: "authorization_request" }),
  "missing fence": value => ({ ...value, fence: undefined }),
  null: () => null
};
for (const field of ["applicationGenerationId", "managerInstanceId", "storageGenerationLease", "roleId", "planId"]) {
  corruptions[`fence ${field}`] = value => ({ ...value, fence: { ...(value.fence as object), [field]: "other" } });
}
for (const [name, corrupt] of Object.entries(corruptions)) {
  test(`worker denies malformed/replayed admission: ${name}`, async () => {
    const transport = new AdmissionTransport();
    const value = request();
    const waiting = acquireStorageMutationCommitAdmission(value, transport);
    const denied = assert.rejects(waiting, StorageMutationAdmissionError);
    transport.emit("message", corrupt({ ...admission(value), kind: "authorization_decision", allowed: true }));
    await denied;
    assertListenersReleased(transport);
  });
}

for (const mode of ["disconnected", "disconnect", "send-error", "send-throw"] as const) {
  test(`worker fails closed on admission transport failure: ${mode}`, async () => {
    const transport = new AdmissionTransport();
    transport.connected = mode !== "disconnected";
    transport.throwSend = mode === "send-throw";
    if (mode === "send-error") transport.sendError = new Error("send fixture failed");
    const denied = assert.rejects(acquireStorageMutationCommitAdmission(request(), transport), StorageMutationAdmissionError);
    if (mode === "disconnect") transport.emit("disconnect");
    await denied;
    assertListenersReleased(transport);
  });
}

test("local unguarded mutation requires no admission transport", async () => {
  const transport = new AdmissionTransport();
  transport.connected = false;
  await acquireStorageMutationCommitAdmission({ ...request(), admissionNonce: undefined }, transport);
  assert.deepEqual(transport.sent, []);
  assertListenersReleased(transport);
});

class AdmissionChild extends EventEmitter implements ManagerStorageMutationChild {
  readonly pid = 42420;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  connected = true;
  readonly channel = { unref(): void {} };
  readonly requests: ManagerStorageMutationRequest[] = [];
  readonly decisions: ManagerStorageMutationAdmission[] = [];
  failDecisionSend = false;
  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    const envelope = message as ManagerStorageMutationRequest | ManagerStorageMutationAdmission;
    if ("kind" in envelope) {
      this.decisions.push(envelope);
      callback?.(this.failDecisionSend ? new Error("decision send failed") : null);
    } else {
      this.requests.push(envelope);
      callback?.(null);
    }
    return true;
  }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.exitCode = 0;
    this.signalCode = typeof signal === "string" ? signal : null;
    this.connected = false;
    this.emit("close", this.exitCode, this.signalCode);
    return true;
  }
  disconnect(): void { this.connected = false; this.emit("disconnect"); }
  unref(): void {}
  complete(value: ManagerStorageMutationRequest, result: unknown): void {
    this.emit("message", { protocolVersion: value.protocolVersion, requestId: value.requestId, fence: value.fence,
      admissionNonce: value.admissionNonce, ok: true, value: result } satisfies ManagerStorageMutationResponse);
  }
}

function poolFixture(t: test.TestContext, child: AdmissionChild): ManagerStorageMutationPool {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "storage-admission-parent-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pool = new ManagerStorageMutationPool({ rolesRoot: root, applicationGenerationId: "generation", managerInstanceId: "manager", childFactory: () => child });
  t.after(() => pool.stop());
  return pool;
}

const operation = { idempotencyKey: "admission-request", expectedRevision: null, timeoutMs: 10_000 };
const task = { type: "plan_create", input: { title: "Admission fixture" } } as const;

function expectPoolFailure(pending: Promise<unknown>, code: ManagerStorageMutationError["code"], commitState?: "unknown"): Promise<void> {
  return assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof ManagerStorageMutationError);
    assert.equal(error.code, code);
    if (commitState) assert.equal(error.commitState, commitState);
    return true;
  });
}

test("parent rechecks original authority at worker admission and preserves unknown commit state on denial", async t => {
  const child = new AdmissionChild();
  const pool = poolFixture(t, child);
  let revoked = false;
  let checks = 0;
  const pending = pool.execute("FixtureRole", "fixture-plan", task, { ...operation, authorize: () => {
    checks++;
    if (revoked) throw new Error("private diagnostic");
  } });
  const denied = expectPoolFailure(pending, "authorization_revoked", "unknown");
  assert.equal(checks, 2);
  const sent = child.requests[0];
  assert.equal("authorize" in sent, false);
  assert.match(sent.admissionNonce!, /^[a-f0-9]{64}$/);
  revoked = true;
  child.emit("message", admission(sent));
  assert.equal(checks, 3);
  assert.equal((child.decisions[0] as { allowed: boolean }).allowed, false);
  child.emit("message", { protocolVersion: sent.protocolVersion, requestId: sent.requestId, fence: sent.fence,
    admissionNonce: sent.admissionNonce, ok: false, code: "authorization_revoked", message: "denied" });
  await denied;
});

test("parent admission allow is irreversible for the operation and uses a fresh nonce on same-key dispatch", async t => {
  const child = new AdmissionChild();
  const pool = poolFixture(t, child);
  let revoked = false;
  const authorize = () => { if (revoked) throw new Error("revoked"); };
  const first = pool.execute("FixtureRole", "fixture-plan", task, { ...operation, authorize });
  const sent = child.requests[0];
  child.emit("message", admission(sent));
  assert.equal((child.decisions[0] as { allowed: boolean }).allowed, true);
  revoked = true;
  child.complete(sent, { id: "fixture-plan" });
  assert.deepEqual(await first, { id: "fixture-plan" });
  revoked = false;
  const replay = pool.execute("FixtureRole", "fixture-plan", task, { ...operation, authorize });
  const replayFailure = expectPoolFailure(replay, "fence_mismatch", "unknown");
  const next = child.requests[1];
  assert.notEqual(next.admissionNonce, sent.admissionNonce);
  child.emit("message", admission(sent));
  await replayFailure;
});

for (const mode of ["premature-final", "duplicate-admission", "wrong-sequence", "decision-as-request", "wrong-fence", "denied-success", "allow-send-failure"] as const) {
  test(`parent rejects invalid admission exchange: ${mode}`, async t => {
    const child = new AdmissionChild();
    const pool = poolFixture(t, child);
    let revoked = false;
    const pending = pool.execute("FixtureRole", "fixture-plan", task, { ...operation, authorize: () => { if (revoked) throw new Error("revoked"); } });
    const denied = expectPoolFailure(pending, mode === "allow-send-failure" ? "worker_failed" : "fence_mismatch", "unknown");
    const sent = child.requests[0];
    if (mode === "premature-final") child.complete(sent, {});
    if (mode === "duplicate-admission") { child.emit("message", admission(sent)); child.emit("message", admission(sent)); }
    if (mode === "wrong-sequence") child.emit("message", { ...admission(sent), sequence: 2 });
    if (mode === "decision-as-request") child.emit("message", { ...admission(sent), kind: "authorization_decision", allowed: true });
    if (mode === "wrong-fence") child.emit("message", { ...admission(sent), fence: { ...sent.fence, managerInstanceId: "other" } });
    if (mode === "denied-success") { revoked = true; child.emit("message", admission(sent)); child.complete(sent, {}); }
    if (mode === "allow-send-failure") { child.failDecisionSend = true; child.emit("message", admission(sent)); }
    await denied;
  });
}

test("pool stop marks active dispatched mutation unknown, unlike queued mutation", async t => {
  const child = new AdmissionChild();
  const pool = poolFixture(t, child);
  const active = pool.execute("FixtureRole", "fixture-plan", task, { ...operation, authorize: () => {} });
  const queued = pool.execute("FixtureRole", "other-plan", task, { ...operation, idempotencyKey: "queued", authorize: () => {} });
  const activeFailure = expectPoolFailure(active, "stopped", "unknown");
  const queuedFailure = expectPoolFailure(queued, "stopped");
  await pool.stop();
  await Promise.all([activeFailure, queuedFailure]);
  assert.equal(child.requests.length, 1);
});

for (const replay of [false, true]) {
  test(`real worker denies before any receipt/domain access: ${replay ? "existing completed receipt" : "fresh request"}`, { timeout: 20_000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "storage-admission-worker-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const roleDir = path.join(root, "FixtureRole");
    fs.mkdirSync(roleDir);
    const pool = new ManagerStorageMutationPool({ rolesRoot: root, applicationGenerationId: "generation", managerInstanceId: "manager" });
    t.after(() => pool.stop());
    const input = { title: "Admission fixture", focus: "Check worker admission", status: "分析中", currentStepId: "verify",
      steps: [{ id: "verify", title: "Verify" }], keywords: ["admission"] };
    const create = (authorize: () => void) => pool.createPlan("FixtureRole", "fixture-plan", input, { ...operation, authorize });
    let beforeReceipt: unknown;
    let beforePlan: unknown;
    if (replay) {
      let allowChecks = 0;
      await create(() => { allowChecks++; });
      assert.equal(allowChecks, 3);
      beforeReceipt = readDurableDeliveryReceipt(path.join(roleDir, "runtime"), MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE, operation.idempotencyKey);
      beforePlan = readPlanStoragePackage(roleDir, "fixture-plan", "active");
      assert.equal((beforeReceipt as { state: string }).state, "completed");
      // A second admission nonce must not affect the stable durable request digest.
      await create(() => {});
      assert.deepEqual(readDurableDeliveryReceipt(path.join(roleDir, "runtime"), MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE, operation.idempotencyKey), beforeReceipt);
    }
    let checks = 0;
    await expectPoolFailure(create(() => { if (++checks === 3) throw new Error("revoked at commit admission"); }), "authorization_revoked", "unknown");
    assert.equal(checks, 3);
    if (replay) {
      assert.deepEqual(readDurableDeliveryReceipt(path.join(roleDir, "runtime"), MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE, operation.idempotencyKey), beforeReceipt);
      assert.deepEqual(readPlanStoragePackage(roleDir, "fixture-plan", "active"), beforePlan);
    } else assert.deepEqual(fs.readdirSync(roleDir), []);
  });
}
