import assert from "node:assert/strict";
import test from "node:test";
import {
  CODEX_APP_SERVER_CHANNEL,
  resolveCodexRuntimeState
} from "./codexRuntimeState.js";

test("Codex runtime state uses app-server stdio and treats ChatGPT as an optional host", () => {
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
  assert.equal(state.deliveryTransport, CODEX_APP_SERVER_CHANNEL);
  assert.equal(state.lastDeliveryChannel, CODEX_APP_SERVER_CHANNEL);
  assert.equal(state.desktopHostName, "ChatGPT");
  assert.equal(state.desktopHostRequired, false);
  assert.equal(state.unexpectedTransportField, undefined);
  assert.doesNotMatch(String(state.message), /Desktop IPC|fallback|可见性/);
});

test("Codex delivery failures are reported through the canonical app-server state", () => {
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
  assert.equal(state.lastDeliveryChannel, CODEX_APP_SERVER_CHANNEL);
  assert.equal(state.unexpectedRetryField, undefined);
  assert.equal(state.message, "Codex app-server stdio 投递失败：runtime unavailable");
  assert.doesNotMatch(String(state.message), /Desktop|worker|fallback|补投/);
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
  assert.equal(state.deliveryTransport, CODEX_APP_SERVER_CHANNEL);
  assert.equal(state.lastDeliveryChannel, undefined);
});
