import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FailureCircuitRegistry, failureSignature } from "./failureCircuit.js";

test("failure circuit uses bounded exponential backoff and opens one incident", () => {
  let now = 1_000;
  const circuit = new FailureCircuitRegistry({
    baseDelayMs: 100,
    maximumDelayMs: 400,
    incidentThreshold: 3,
    now: () => now
  });

  const first = circuit.recordFailure("memory:role", new Error("NAS unavailable"));
  assert.equal(first.delayMs, 100);
  assert.equal(first.shouldReport, true);
  assert.equal(first.incidentOpened, false);
  assert.equal(circuit.canAttempt("memory:role"), false);

  now = first.snapshot.retryAt;
  const second = circuit.recordFailure("memory:role", new Error("NAS unavailable"));
  assert.equal(second.delayMs, 200);
  assert.equal(second.shouldReport, false);

  now = second.snapshot.retryAt;
  const third = circuit.recordFailure("memory:role", new Error("NAS unavailable"));
  assert.equal(third.delayMs, 400);
  assert.equal(third.incidentOpened, true);
  assert.equal(third.snapshot.phase, "incident");
  assert.ok(third.snapshot.incidentId);

  now = third.snapshot.retryAt;
  const fourth = circuit.recordFailure("memory:role", new Error("NAS unavailable"));
  assert.equal(fourth.delayMs, 400);
  assert.equal(fourth.incidentOpened, false);
  assert.equal(fourth.snapshot.incidentId, third.snapshot.incidentId);
});

test("a new failure signature starts a new bounded series and success closes it", () => {
  let now = 10;
  const circuit = new FailureCircuitRegistry({
    baseDelayMs: 10,
    maximumDelayMs: 100,
    incidentThreshold: 3,
    now: () => now
  });
  circuit.recordFailure("scan", Object.assign(new Error("first"), { code: "EIO" }));
  now += 10;
  const changed = circuit.recordFailure("scan", Object.assign(new Error("second"), { code: "ENOENT" }));
  assert.equal(changed.snapshot.consecutiveFailures, 1);
  assert.equal(changed.shouldReport, true);
  circuit.recordSuccess("scan");
  assert.equal(circuit.inspect("scan"), undefined);
  assert.equal(circuit.canAttempt("scan"), true);
});

test("failure signatures redact absolute roots while preserving error identity", () => {
  assert.equal(
    failureSignature(new Error("cannot read C:\\Users\\one\\private.json")),
    failureSignature(new Error("cannot read D:\\Users\\two\\private.json"))
  );
  assert.notEqual(failureSignature(new Error("timeout")), failureSignature(new Error("permission denied")));
});

test("failure circuit persists only hashed scope keys and restores an open episode", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-failure-circuit-"));
  const persistencePath = path.join(root, "state.json");
  let now = 1_000;
  const options = {
    baseDelayMs: 100,
    maximumDelayMs: 400,
    incidentThreshold: 2,
    now: () => now,
    persistencePath
  };
  const first = new FailureCircuitRegistry(options);
  first.recordFailure("C:\\private\\role-a", new Error("NAS unavailable"));
  now += 100;
  const opened = first.recordFailure("C:\\private\\role-a", new Error("NAS unavailable"));

  const raw = fs.readFileSync(persistencePath, "utf8");
  assert.doesNotMatch(raw, /private|role-a/);
  const restored = new FailureCircuitRegistry(options);
  assert.equal(restored.inspect("C:\\private\\role-a")?.incidentId, opened.snapshot.incidentId);
  assert.equal(restored.canAttempt("C:\\private\\role-a"), false);
});
