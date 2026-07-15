import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import {
  activeTurnIdFromResumedThreadForTest,
  buildChildEnvWithNodeOnPath,
  codexThreadDeliveryTargetIsStaleForTest,
  codexThreadMatchesConfiguredTargetForTest
} from "./codexRuntime.js";

test("thread/resume restores the latest in-progress turn for steering", () => {
  assert.equal(
    activeTurnIdFromResumedThreadForTest({
      turns: [
        { id: "turn-complete", status: "completed" },
        { id: "turn-active", status: "inProgress" }
      ]
    }),
    "turn-active"
  );
  assert.equal(activeTurnIdFromResumedThreadForTest({ turns: [{ id: "turn-failed", status: "failed" }] }), undefined);
  assert.equal(activeTurnIdFromResumedThreadForTest({ turns: "invalid" }), undefined);
});

test("buildChildEnvWithNodeOnPath prepends bundled node directory on POSIX-like env", () => {
  const env = buildChildEnvWithNodeOnPath(
    { PATH: "/usr/bin", OTHER: "value" },
    "/opt/rabiroute/node/bin/node",
    ":"
  );

  assert.equal(env.PATH, "/opt/rabiroute/node/bin:/usr/bin");
  assert.equal(env.OTHER, "value");
});

test("buildChildEnvWithNodeOnPath preserves Windows Path key and removes duplicate variants", () => {
  const env = buildChildEnvWithNodeOnPath(
    { Path: "C:\\Windows\\System32", PATH: "ignored", OTHER: "value" },
    "C:\\Tools\\node\\node.exe",
    ";"
  );

  assert.equal(env.Path, "C:\\Tools\\node;C:\\Windows\\System32");
  assert.equal(env.PATH, undefined);
  assert.equal(env.OTHER, "value");
});

test("Codex app-server treats thread name plus cwd as the delivery target", () => {
  const currentCwd = path.resolve("C:/Projects/RabiRoute");

  assert.equal(
    codexThreadMatchesConfiguredTargetForTest({ name: "Rabi", cwd: currentCwd }, "Rabi", currentCwd),
    true
  );
  assert.equal(
    codexThreadMatchesConfiguredTargetForTest({ name: "Rabi", cwd: "D:/Projects/RabiRoute" }, "Rabi", currentCwd),
    false
  );
  assert.equal(
    codexThreadMatchesConfiguredTargetForTest({ name: "别的会话", cwd: currentCwd }, "Rabi", currentCwd),
    false
  );
});

test("Codex app-server treats archived rollout errors as stale delivery targets", () => {
  assert.equal(
    codexThreadDeliveryTargetIsStaleForTest(new Error('{"code":-32600,"message":"no rollout found for thread id 019f481b-7b3d-7671-a362-bc915ff2a250"}')),
    true
  );
  assert.equal(
    codexThreadDeliveryTargetIsStaleForTest(new Error("thread not found")),
    true
  );
  assert.equal(
    codexThreadDeliveryTargetIsStaleForTest(new Error("model temporarily unavailable")),
    false
  );
});
