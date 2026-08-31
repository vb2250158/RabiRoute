import assert from "node:assert/strict";
import test from "node:test";
import {
  gatewayRuntimeStartDecision,
  gatewayRuntimeSyncAction,
  managerAutostartEnabled,
  managerConfigWatcherEnabled,
  managerReadOnlyEnabled,
  managerReadOnlyRequestAllowed
} from "./managerRuntimeMode.js";

test("explicit config reconciliation restarts an already running gateway when autostart is disabled", () => {
  assert.equal(gatewayRuntimeSyncAction({
    managerShouldAutostart: false,
    enabled: true,
    runtimeRequired: true,
    running: true,
    needsRestart: true
  }), "restart");
});

test("disabled autostart does not start a stopped gateway", () => {
  assert.equal(gatewayRuntimeSyncAction({
    managerShouldAutostart: false,
    enabled: true,
    runtimeRequired: true,
    running: false,
    needsRestart: false
  }), "none");
});

test("disabled autostart still stops a running gateway that was disabled explicitly", () => {
  assert.equal(gatewayRuntimeSyncAction({
    managerShouldAutostart: false,
    enabled: false,
    runtimeRequired: true,
    running: true,
    needsRestart: false
  }), "stop");
});

test("enabled autostart starts a stopped gateway and leaves unchanged runtimes alone", () => {
  assert.equal(gatewayRuntimeSyncAction({
    managerShouldAutostart: true,
    enabled: true,
    runtimeRequired: true,
    running: false,
    needsRestart: false
  }), "start");
  assert.equal(gatewayRuntimeSyncAction({
    managerShouldAutostart: true,
    enabled: true,
    runtimeRequired: true,
    running: true,
    needsRestart: false
  }), "none");
});

test("enabled internal-only routes do not start a resident Gateway", () => {
  assert.equal(gatewayRuntimeSyncAction({
    managerShouldAutostart: true,
    enabled: true,
    runtimeRequired: false,
    running: false,
    needsRestart: false
  }), "none");
});

test("running Gateways stop when their Route becomes internal-only", () => {
  assert.equal(gatewayRuntimeSyncAction({
    managerShouldAutostart: true,
    enabled: true,
    runtimeRequired: false,
    running: true,
    needsRestart: true
  }), "stop");
});

test("manual start skips internal-only Routes", () => {
  assert.equal(gatewayRuntimeStartDecision({
    enabled: true,
    runtimeRequired: false,
    running: false
  }), "skip-not-required");
});

test("manual start only creates an enabled required Gateway process", () => {
  assert.equal(gatewayRuntimeStartDecision({ enabled: false, runtimeRequired: true, running: false }), "skip-disabled");
  assert.equal(gatewayRuntimeStartDecision({ enabled: true, runtimeRequired: true, running: true }), "already-running");
  assert.equal(gatewayRuntimeStartDecision({ enabled: true, runtimeRequired: true, running: false }), "start");
});

test("Manager autostart is enabled by default and disabled only by explicit zero", () => {
  assert.equal(managerAutostartEnabled(undefined), true);
  assert.equal(managerAutostartEnabled("1"), true);
  assert.equal(managerAutostartEnabled("false"), true);
  assert.equal(managerAutostartEnabled("0"), false);
});

test("knowledge-only Manager mode disables route config polling", () => {
  assert.equal(managerConfigWatcherEnabled(undefined), true);
  assert.equal(managerConfigWatcherEnabled("1"), true);
  assert.equal(managerConfigWatcherEnabled("0"), false);
});

test("Manager read-only mode requires an explicit one", () => {
  assert.equal(managerReadOnlyEnabled(undefined), false);
  assert.equal(managerReadOnlyEnabled("0"), false);
  assert.equal(managerReadOnlyEnabled("true"), false);
  assert.equal(managerReadOnlyEnabled("1"), true);
});

test("Manager read-only mode accepts observation methods and rejects mutations", () => {
  assert.equal(managerReadOnlyRequestAllowed("GET"), true);
  assert.equal(managerReadOnlyRequestAllowed("HEAD"), true);
  assert.equal(managerReadOnlyRequestAllowed("OPTIONS"), true);
  assert.equal(managerReadOnlyRequestAllowed("POST"), false);
  assert.equal(managerReadOnlyRequestAllowed("POST", "/_rabiroute/host/shutdown"), true);
  assert.equal(managerReadOnlyRequestAllowed("POST", "/manager/shutdown"), false);
  assert.equal(managerReadOnlyRequestAllowed("PUT"), false);
  assert.equal(managerReadOnlyRequestAllowed("PATCH"), false);
  assert.equal(managerReadOnlyRequestAllowed("DELETE"), false);
});
