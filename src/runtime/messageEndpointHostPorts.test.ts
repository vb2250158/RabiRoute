import assert from "node:assert/strict";
import test from "node:test";
import { createMessageEndpointHostPorts } from "./messageEndpointHostPorts.js";
import { launchProtectedProcess } from "./protectedProcessLauncher.js";
import { pluginStorageResourceRoot, pluginStorageMigrationFailure } from "../shared/pluginStorage.js";
import { createFeishuNativeOperations, createNapCatNativeOperations } from "../adapters/platformNativeOperations.js";
import { validateLocalModelDirectory } from "../shared/localModelDirectory.js";
import { stickySpeechAuthority, awaitSpeechAuthority } from "../shared/speechRequestAuthority.js";
import { normalizeSpeechIngressRecord } from "../speechIngressStore.js";

test("shared owners load once on demand and an unrelated failed owner stays local", async () => {
  let brokenLoads = 0, healthyLoads = 0;
  const healthyOwner = Object.freeze({ record: () => "healthy" });
  const ports = await createMessageEndpointHostPorts({ loaders: {
    broken: async () => { brokenLoads += 1; throw new Error("controlled owner import failure"); },
    healthy: async () => { healthyLoads += 1; return healthyOwner; }
  } });
  assert.equal(brokenLoads + healthyLoads, 0, "Constructing ports never imports optional owners.");
  await assert.rejects(ports.prepareModules(["broken"]), /controlled owner import failure/);
  await Promise.all([ports.prepareModules(["healthy"]), ports.prepareModules(["healthy"])]);
  assert.equal(ports.module("healthy"), healthyOwner);
  assert.equal(healthyLoads, 1);
  assert.equal(brokenLoads, 1);
});


test("published Xiaomi and native listener dependencies prepare through their single shared owners", async () => {
  const ports = await createMessageEndpointHostPorts();
  const ids = ["runtime/protectedProcessLauncher", "shared/pluginStorage", "adapters/platformNativeOperations"];
  assert.throws(() => ports.module(ids[0]!), /Shared endpoint owner is unavailable/);
  await Promise.all([ports.prepareModules(ids), ports.prepareModules(ids)]);
  ports.assertModules(ids);
  const launcher = ports.module<typeof import("./protectedProcessLauncher.js")>(ids[0]!);
  const storage = ports.module<typeof import("../shared/pluginStorage.js")>(ids[1]!);
  const listeners = ports.module<typeof import("../adapters/platformNativeOperations.js")>(ids[2]!);
  assert.equal(launcher.launchProtectedProcess, launchProtectedProcess);
  assert.equal(storage.pluginStorageResourceRoot, pluginStorageResourceRoot);
  assert.equal(storage.pluginStorageMigrationFailure, pluginStorageMigrationFailure);
  assert.equal(listeners.createFeishuNativeOperations, createFeishuNativeOperations);
  assert.equal(listeners.createNapCatNativeOperations, createNapCatNativeOperations);
  await ports.prepareModules(ids);
  assert.equal(ports.module(ids[0]!), launcher);
  assert.equal(ports.module(ids[1]!), storage);
  assert.equal(ports.module(ids[2]!), listeners);
});

test("published Speech dependencies prepare through their single shared helper and ingress owner", async () => {
  const ports = await createMessageEndpointHostPorts();
  const ids = ["shared/localModelDirectory", "shared/speechRequestAuthority", "speechIngressStore"];
  assert.throws(() => ports.module(ids[0]!), /Shared endpoint owner is unavailable/);
  await Promise.all([ports.prepareModules(ids), ports.prepareModules(ids)]);
  ports.assertModules(ids);
  const directory = ports.module<typeof import("../shared/localModelDirectory.js")>(ids[0]!);
  const authority = ports.module<typeof import("../shared/speechRequestAuthority.js")>(ids[1]!);
  const ingress = ports.module<typeof import("../speechIngressStore.js")>(ids[2]!);
  assert.equal(directory.validateLocalModelDirectory, validateLocalModelDirectory);
  assert.equal(authority.stickySpeechAuthority, stickySpeechAuthority);
  assert.equal(authority.awaitSpeechAuthority, awaitSpeechAuthority);
  assert.equal(ingress.normalizeSpeechIngressRecord, normalizeSpeechIngressRecord);
  await ports.prepareModules(ids);
  assert.equal(ports.module(ids[0]!), directory);
  assert.equal(ports.module(ids[1]!), authority);
  assert.equal(ports.module(ids[2]!), ingress);
  await assert.rejects(ports.prepareModules(["private/nonexistent-speech-owner"]), /Shared endpoint owner is unavailable/);
  assert.equal(ports.module(ids[2]!), ingress);
});

test("undeclared prototype names are not shared owner loaders and leave healthy modules usable", async () => {
  const healthy = Object.freeze({ value: "healthy" });
  const ports = await createMessageEndpointHostPorts({ loaders: { healthy: async () => healthy } });
  await ports.prepareModules(["healthy"]);
  for (const id of ["constructor", "toString", "__proto__"]) {
    await assert.rejects(ports.prepareModules([id]), { message: "Shared endpoint owner is unavailable: " + id });
    assert.throws(() => ports.module(id), { message: "Shared endpoint owner is unavailable: " + id });
    assert.equal(ports.module("healthy"), healthy);
  }
});

test("an explicitly configured own constructor loader keeps its declared identity", async () => {
  const owner = Object.freeze({ value: "explicit-constructor-owner" });
  let calls = 0;
  const ports = await createMessageEndpointHostPorts({ loaders: { constructor: async () => { calls += 1; return owner; } } });
  await Promise.all([ports.prepareModules(["constructor"]), ports.prepareModules(["constructor"])]);
  ports.assertModules(["constructor"]);
  assert.equal(ports.module("constructor"), owner);
  assert.equal(calls, 1);
});
