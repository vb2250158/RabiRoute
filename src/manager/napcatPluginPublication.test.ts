import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { NapcatManagerResources } from "../plugins/io.rabiroute.endpoint.napcat/src/integrations/napcat/managerOwner.js";
import { NapcatLifecycleOwner, type NapcatBinding } from "../plugins/io.rabiroute.endpoint.napcat/src/manager/napcatLifecycleOwner.js";
import { napcatEndpointFixture } from "./napcatEndpointPlugin.fixture.js";

const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test("the actual bundled NapCat manager owns its API, scan and process records; failed preparation preserves them", { timeout: 60000 }, async () => {
  const f = await napcatEndpointFixture();
  try {
    await f.kernel.switch([f.candidate("old")]);
    assert.equal(f.kernel.current().records[0]?.status, "active", JSON.stringify(f.kernel.current()));
    const activation = f.kernel.current().records[0]!.identity.activationId;
    const provider = f.scanProviders.snapshot()[0];
    assert.equal(provider.type, "napcat");
    assert.equal(f.operations.snapshot().reduce((count, entry) => count + entry.routeCount, 0), 19);
    const recordPath = path.join(f.root, "data/.runtime/napcat-process-ownership.json");
    const records = await fs.readFile(recordPath, "utf8");
    await f.kernel.switch([f.candidate("failed", { activate(context) { context.effects.add(() => { throw new Error("controlled candidate failure"); }); } })]);
    assert.equal(f.kernel.current().records[0]!.identity.activationId, activation);
    assert.equal(f.scanProviders.snapshot()[0], provider);
    assert.equal(await fs.readFile(recordPath, "utf8"), records, "A rejected candidate does not construct a new process owner.");
    await f.kernel.switch([]);
    assert.deepEqual(f.scanProviders.snapshot(), []);
    assert.deepEqual(f.operations.snapshot(), []);
    assert.equal(await fs.readFile(recordPath, "utf8"), records, "Retirement preserves managed process identity records for the next original owner.");
  } finally { await f.dispose(); }
});

test("the combined NapCat endpoint waits for the exact previous owner retirement before activating its replacement", { timeout: 60000 }, async () => {
  const f = await napcatEndpointFixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    f.setDisposalGate(gate);
    await f.kernel.switch([f.candidate("old")]);
    f.setDisposalGate(undefined);
    let complete = false;
    const switching = f.kernel.switch([f.candidate("new")]).then(() => { complete = true; });
    for (let count = 0; count < 100 && f.kernel.current().records[0]?.identity.revision !== "new"; count++) await turn();
    assert.equal(complete, false);
    release(); await switching;
    assert.equal(f.kernel.current().records[0]?.identity.revision, "new");
    assert.equal(f.kernel.current().records[0]?.status, "active");
    assert.equal(f.scanProviders.snapshot().length, 1);
    assert.equal(f.operations.snapshot().reduce((count, entry) => count + entry.routeCount, 0), 19);
  } finally { release(); await f.dispose(); }
});

test("a synchronous publication failure restores the original NapCat operations and scan owner", { timeout: 60000 }, async () => {
  const f = await napcatEndpointFixture();
  try {
    await f.kernel.switch([f.candidate("old")]);
    assert.equal(f.kernel.current().records[0]?.status, "active", JSON.stringify(f.kernel.current()));
    const activation = f.kernel.current().records[0]!.identity.activationId;
    const provider = f.scanProviders.snapshot()[0];
    await assert.rejects(f.kernel.switch([f.candidate("bad-publication", { activate(context) {
      context.publication.add({ publish() { throw new Error("controlled publication failure"); }, rollback() {} });
    } })]), /controlled publication failure/);
    assert.equal(f.kernel.current().records[0]!.identity.activationId, activation);
    assert.equal(f.scanProviders.snapshot()[0], provider);
    assert.equal(f.operations.snapshot().reduce((count, entry) => count + entry.routeCount, 0), 19);
  } finally { await f.dispose(); }
});

test("the real NapCat plugin hands one live process owner to a replacement and stops its native child on disable", { timeout: 60000, skip: process.platform !== "win32" }, async t => {
  const f = await napcatEndpointFixture();
  const binding: NapcatBinding = { gatewayId: "fixture-route", instanceId: "fixture-qq", workingDir: f.root, httpUrl: "http://127.0.0.1:1" };
  f.setRoutes([{ id: binding.gatewayId, gatewayPort: 12345, messageAdapters: ["napcat"], napcatInstances: [
    { id: binding.instanceId, gatewayPort: 12345, httpUrl: binding.httpUrl, workingDir: binding.workingDir }
  ] }]);
  const external = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { windowsHide: true, stdio: "ignore" });
  const externalClosed = once(external, "close");
  let owned: ReturnType<typeof spawn> | undefined, ownedClosed: Promise<unknown> | undefined;
  try {
    await f.kernel.switch([f.candidate("old")]);
    const resources = f.managers.current("napcat")!.resources as NapcatManagerResources;
    assert.ok(resources.processOwner);
    await resources.processOwner.launch(binding, () => {
      owned = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { windowsHide: true, stdio: "ignore" });
      ownedClosed = once(owned, "close");
      return owned;
    });
    const records = JSON.parse(await fs.readFile(path.join(f.root, "data/.runtime/napcat-process-ownership.json"), "utf8"));
    assert.equal(records.records[0].launchPending, undefined, "the native snapshot captured the actual spawned child");
    await f.kernel.switch([f.candidate("new")]);
    assert.equal(f.managers.current("napcat")!.resources, resources, "one original process owner survives replacement");
    assert.equal(owned!.exitCode, null);
    await f.kernel.switch([f.candidate("rejected", { activate(context) { context.effects.add(() => { throw new Error("controlled preparation failure"); }); } })]);
    assert.equal(f.managers.current("napcat")!.resources, resources);
    assert.equal(owned!.exitCode, null, "a rejected candidate cannot stop the published owner's process");
    const disabled = await f.kernel.switch([]);
    await ownedClosed;
    await resources.processOwner.shutdown();
    assert.notEqual(owned!.exitCode ?? owned!.signalCode, null, "disable joins the exact owned native process");
    assert.equal(external.exitCode, null, "an externally started process is not adopted or stopped");
    assert.equal(JSON.parse(await fs.readFile(path.join(f.root, "data/.runtime/napcat-process-ownership.json"), "utf8")).records.length, 0);
    const restored = await f.kernel.switch([f.candidate("again")]);
    assert.equal(restored.generation.records[0]?.status, "active", "a completed native retirement releases the original fence");
    assert.notEqual(f.managers.current("napcat")!.resources, resources, "reenabling creates a fresh resource owner");
    t.diagnostic(JSON.stringify({ ownedPid: owned!.pid, externalPid: external.pid, exactChildClosed: true,
      ordinaryDisposalDiagnostics: disabled.generation.cleanupDiagnostics.length }));
  } finally {
    if (owned && owned.exitCode === null && owned.signalCode === null) owned.kill();
    if (ownedClosed) await ownedClosed;
    if (external.exitCode === null && external.signalCode === null) external.kill();
    await externalClosed;
    await f.dispose();
  }
});

test("NapCat disable preserves failed process retirement and fences a replacement", { timeout: 60000 }, async () => {
  const f = await napcatEndpointFixture();
  try {
    await f.kernel.switch([f.candidate("old")]);
    const binding: NapcatBinding = { gatewayId: "fixture-route", instanceId: "fixture-qq", httpUrl: "http://127.0.0.1:1" };
    const statePath = path.join(f.root, "controlled-ownership.json");
    const process = { pid: 123456, parentPid: 0, executable: path.join(f.root, "controlled-only.exe"), startedAt: "fixture-birth" };
    const owner = new NapcatLifecycleOwner({ statePath, driver: {
      snapshot: async () => [process], terminate: async () => { throw new Error("controlled stop failure"); }
    }, log() {} });
    const resources = f.managers.current("napcat")!.resources as NapcatManagerResources;
    resources.processOwner = owner;
    await owner.reconcile([binding]); owner.prepareLaunch(binding); await owner.recordLaunch(binding, process.pid);
    const disabled = await f.kernel.switch([]);
    assert.ok(disabled.generation.cleanupDiagnostics.some(item => /retirement failed/.test(item.message)));
    assert.equal(JSON.parse(await fs.readFile(statePath, "utf8")).records.length, 1);
    const replacement = await f.kernel.switch([f.candidate("next")]);
    assert.match(replacement.generation.records[0]?.error?.message ?? "", /retirement is unconfirmed/);
    await assert.rejects(owner.run(binding, async () => {}), /未绑定/);
  } finally { await f.dispose().catch(error => { assert.match(String(error), /retirement|cleanup|dispos/i); }); }
});
