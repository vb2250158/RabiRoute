import assert from "node:assert/strict";
import test from "node:test";
import {
  CODEX_DESKTOP_CHANNEL,
  resolveCodexRuntimeState
} from "./codexRuntimeState.js";

test("Codex runtime state reports Desktop IPC as the only delivery channel", () => {
  const state = resolveCodexRuntimeState(
    { bound: false },
    {
      monitorThreadId: "thread-current",
      lastNotificationAt: "2026-07-10T12:00:00.000Z",
      unexpectedTransportField: "must-not-leak"
    }
  );

  assert.equal(state.bound, true);
  assert.equal(state.deliveryHealthy, true);
  assert.equal(state.deliveryTransport, CODEX_DESKTOP_CHANNEL);
  assert.equal(state.lastDeliveryChannel, CODEX_DESKTOP_CHANNEL);
  assert.equal(state.desktopHostName, "Codex/ChatGPT Desktop");
  assert.equal(state.desktopHostRequired, true);
  assert.equal(state.unexpectedTransportField, undefined);
  assert.match(String(state.message), /桌面任务中实时显示/);
});

test("Codex delivery failures are reported through the canonical Desktop state", () => {
  const state = resolveCodexRuntimeState(
    {},
    {
      monitorThreadId: "thread-current",
      lastNotificationError: "runtime unavailable",
      unexpectedRetryField: 2
    }
  );

  assert.equal(state.bound, false);
  assert.equal(state.deliveryHealthy, false);
  assert.equal(state.lastDeliveryChannel, CODEX_DESKTOP_CHANNEL);
  assert.equal(state.unexpectedRetryField, undefined);
  assert.equal(state.message, "Codex Desktop 投递失败：runtime unavailable");
  assert.doesNotMatch(String(state.message), /worker|fallback|补投/);
});

test("configured Codex metadata alone is not an active runtime binding", () => {
  const state = resolveCodexRuntimeState(
    {
      monitorThreadName: "Configured monitor",
      monitorProjectPath: "G:/work"
    },
    {}
  );

  assert.equal(state.bound, false);
  assert.equal(state.deliveryHealthy, false);
  assert.equal(state.deliveryTransport, CODEX_DESKTOP_CHANNEL);
  assert.equal(state.lastDeliveryChannel, undefined);
});
