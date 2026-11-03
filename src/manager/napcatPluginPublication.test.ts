import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { napcatEndpointFixture } from "./napcatEndpointPlugin.fixture.js";

const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test("the actual bundled NapCat manager owns its API, scan and process records; failed preparation preserves them", { timeout: 60000 }, async () => {
  const f = await napcatEndpointFixture();
  try {
    await f.kernel.switch([f.candidate("old")]);
    const activation = f.kernel.current().records[0]!.identity.activationId;
    const provider = f.scanProviders.snapshot()[0];
    assert.equal(provider.type, "napcat");
    assert.equal(f.operations.snapshot().reduce((count, entry) => count + entry.routeCount, 0), 10);
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
    assert.equal(f.operations.snapshot().reduce((count, entry) => count + entry.routeCount, 0), 10);
  } finally { release(); await f.dispose(); }
});

test("a synchronous publication failure restores the original NapCat operations and scan owner", { timeout: 60000 }, async () => {
  const f = await napcatEndpointFixture();
  try {
    await f.kernel.switch([f.candidate("old")]);
    const activation = f.kernel.current().records[0]!.identity.activationId;
    const provider = f.scanProviders.snapshot()[0];
    await assert.rejects(f.kernel.switch([f.candidate("bad-publication", { activate(context) {
      context.publication.add({ publish() { throw new Error("controlled publication failure"); }, rollback() {} });
    } })]), /controlled publication failure/);
    assert.equal(f.kernel.current().records[0]!.identity.activationId, activation);
    assert.equal(f.scanProviders.snapshot()[0], provider);
    assert.equal(f.operations.snapshot().reduce((count, entry) => count + entry.routeCount, 0), 10);
  } finally { await f.dispose(); }
});
