import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BilibiliHistoryBridge, type BilibiliHistoryJob } from "./bilibiliHistoryBridge.js";
import { GenerationRuntime } from "../plugin-kernel/generationRuntime.js";
import { InProcessPluginExecutor } from "../plugin-kernel/pluginExecutor.js";
import type { PluginCandidate } from "../plugin-kernel/types.js";
import { createBilibiliHistoryOperations } from "./bilibiliHistoryOperations.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";

function historyJob(id: string, status: BilibiliHistoryJob["status"], roleId?: string): BilibiliHistoryJob {
  return { id, status, roleId, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    sinceEpoch: 100, untilEpoch: 300, timezoneOffsetMinutes: 0, cursor: { max: 1, view_at: 200, business: "archive" },
    pagesProcessed: 3, pageDelayMs: 650, lastPageKey: "original-page", lastError: "",
    summary: { itemCount: 0, consumedSeconds: 0, completedCount: 0, activeDays: {}, businessCounts: {}, tagCounts: {}, authorCounts: {}, themeCounts: {} } };
}

function stateFixture(t: import("node:test").TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-bili-lifecycle-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("rabiroute-bili-lifecycle-"));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const rolesRoot = path.join(dir, "data", "roles");
  fs.mkdirSync(path.join(rolesRoot, "Viewer"), { recursive: true });
  const statePath = path.join(dir, "data", "runtime", "bilibili-history-bridge.json");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const jobs = [historyJob("legacy-running", "running"), historyJob("legacy-queued", "queued"),
    historyJob("original-running", "running", "Viewer"), historyJob("original-queued", "queued", "Viewer")];
  const original = JSON.stringify({ version: 1, jobs });
  fs.writeFileSync(statePath, original);
  return { dir, rolesRoot, statePath, jobs, original };
}

test("constructing and discarding a candidate never pauses or rewrites the original queue", t => {
  const fixture = stateFixture(t);
  const before = fs.statSync(fixture.statePath);
  const bridge = new BilibiliHistoryBridge(fixture.statePath, fixture.rolesRoot);
  assert.equal(fs.readFileSync(fixture.statePath, "utf8"), fixture.original);
  assert.equal(fs.statSync(fixture.statePath).mtimeMs, before.mtimeMs);
  assert.throws(() => bridge.status(), /not published/);
  bridge.close();
  assert.equal(fs.readFileSync(fixture.statePath, "utf8"), fixture.original);
});

test("publication reloads the original queue and only then migrates legacy jobs", t => {
  const fixture = stateFixture(t);
  const bridge = new BilibiliHistoryBridge(fixture.statePath, fixture.rolesRoot);
  // These are writes by the still-active original owner after preparation began.
  fixture.jobs[2]!.pagesProcessed = 4;
  fixture.jobs[2]!.cursor.view_at = 175;
  fixture.jobs.push(historyJob("late-queued", "queued", "Viewer"));
  fs.writeFileSync(fixture.statePath, JSON.stringify({ version: 1, jobs: fixture.jobs }));
  bridge.publish();
  const persisted = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
  assert.deepEqual(persisted.jobs.slice(2), fixture.jobs.slice(2));
  assert.ok(persisted.jobs.slice(0, 2).every((job: BilibiliHistoryJob) => job.status === "paused" && /roleId/.test(job.lastError)));
  const committed = fs.readFileSync(fixture.statePath, "utf8");
  bridge.publish();
  assert.equal(fs.readFileSync(fixture.statePath, "utf8"), committed);
  bridge.close();
  assert.throws(() => bridge.publish(), /retired/);
});

test("read-only publication pauses only its own snapshot and does not rewrite durable jobs", t => {
  const fixture = stateFixture(t);
  const bridge = new BilibiliHistoryBridge(fixture.statePath, fixture.rolesRoot, { readOnly: true });
  bridge.publish();
  assert.equal((bridge.job("legacy-running").body.job as BilibiliHistoryJob).status, "paused");
  assert.equal(fs.readFileSync(fixture.statePath, "utf8"), fixture.original);
  bridge.close();
});

test("a constructor failure after native allocation leaves the original persisted jobs byte-identical", t => {
  const fixture = stateFixture(t);
  class BrokenCandidate extends BilibiliHistoryBridge {
    constructor() {
      super(fixture.statePath, fixture.rolesRoot);
      throw new Error("candidate construction failed");
    }
  }
  assert.throws(() => new BrokenCandidate(), /candidate construction failed/);
  assert.equal(fs.readFileSync(fixture.statePath, "utf8"), fixture.original);
});

test("a publication persistence failure leaves the original file intact and fences the failed owner", t => {
  const fixture = stateFixture(t);
  const bridge = new BilibiliHistoryBridge(fixture.statePath, fixture.rolesRoot);
  // Fail the existing atomic-write staging step without touching the original file.
  fs.mkdirSync(`${fixture.statePath}.${process.pid}.tmp`);
  assert.throws(() => bridge.publish());
  assert.equal(fs.readFileSync(fixture.statePath, "utf8"), fixture.original);
  assert.throws(() => bridge.status(), /retired/);
  assert.throws(() => bridge.publish(), /retired/);
});

async function pluginFixture(t: import("node:test").TestContext) {
  const fixture = stateFixture(t);
  const owners: BilibiliHistoryBridge[] = [];
  const events: string[] = [];
  let failConstruction = false;
  let failOperations = false;
  let failPublication = false;
  let effectBarrier: (() => Promise<void>) | undefined;
  let kernel!: GenerationRuntime;
  const routes = new ManagerPluginRouteRegistry(() => new Set(kernel.current().records
    .filter(record => record.status === "active").map(record => record.identity.activationId)));
  const entry = path.resolve("plugins/builtin/io.rabiroute.manager.bilibili-history/1.0.0/manager.mjs");
  const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(entry), "rabi.plugin.json"), "utf8"));
  class TrackedBridge extends BilibiliHistoryBridge {
    constructor(...args: ConstructorParameters<typeof BilibiliHistoryBridge>) {
      super(...args);
      owners.push(this);
      if (failConstruction) { failConstruction = false; throw new Error("controlled constructor failure"); }
    }
    override publish(): void {
      const record = kernel.current().records.find(record => record.identity.instanceId === "manager:bilibili-history");
      assert.ok(record, "native publish must follow formal kernel publication");
      assert.equal(record.status, "active");
      events.push(`publish:${record.identity.revision}`);
      super.publish();
    }
    override close(): void { events.push(`close:${owners.indexOf(this)}`); super.close(); }
  }
  const executor = new InProcessPluginExecutor();
  kernel = new GenerationRuntime({ host: "manager", readyRequires: ["manager.bilibili-history@1"],
    hostServices: [{ capability: "manager.core@1", value: {} }, { capability: "manager.persona@1", value: {} },
      { capability: "host.manager.bilibili-history@1", value: {
        BilibiliHistoryBridge: TrackedBridge, path, rootDir: fixture.dir, configRepository: { rolesRoot: fixture.rolesRoot },
        managerReadOnly: false, managerPluginRoutes: routes,
        createBilibiliHistoryOperations(owner: BilibiliHistoryBridge) {
          if (failOperations) { failOperations = false; throw new Error("controlled operations failure"); }
          return createBilibiliHistoryOperations(owner);
        }
      } }],
    executor: { async prepare(candidate, identity) {
      const module = await executor.prepare(candidate, identity);
      return { async activate(context) {
        await module.activate(context);
        if (failPublication) {
          failPublication = false;
          context.publication.add({ publish() { throw new Error("controlled synchronous publication failure"); }, rollback() {} }, "controlled publication failure");
        }
        const barrier = effectBarrier;
        if (barrier) context.effects.add(async () => { await barrier(); return () => {}; }, "controlled candidate barrier");
      } };
    } },
    onPublished: () => { routes.refreshPublication(); }
  });
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (!routes.handle(request, url, response)) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await kernel.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const candidate = (revision: string): PluginCandidate => ({ instanceId: "manager:bilibili-history", revision, manifest,
    config: {}, entry: { execution: "in_process", path: entry } });
  return { ...fixture, kernel, routes, owners, events, baseUrl, candidate,
    failConstruction: () => { failConstruction = true; }, failOperations: () => { failOperations = true; },
    failPublication: () => { failPublication = true; },
    setBarrier: (barrier?: () => Promise<void>) => { effectBarrier = barrier; } };
}

test("kernel candidate construction failure cannot migrate durable legacy jobs", async t => {
  const app = await pluginFixture(t);
  app.failConstruction();
  await assert.rejects(app.kernel.switch([app.candidate("broken")]), /Required plugin capabilities/);
  assert.equal(fs.readFileSync(app.statePath, "utf8"), app.original);
  assert.equal(app.routes.snapshot().length, 0);
  assert.ok(!app.events.some(event => event.startsWith("publish:")));
});

test("a failed staged candidate cleans only itself while the original queue remains callable", async t => {
  const app = await pluginFixture(t);
  await app.kernel.switch([app.candidate("original")]);
  const originalOwner = app.owners[0]!;
  const committed = fs.readFileSync(app.statePath, "utf8");
  app.failOperations();
  await app.kernel.switch([app.candidate("bad-operations")]);
  assert.equal(fs.readFileSync(app.statePath, "utf8"), committed);
  assert.equal(originalOwner.job("original-running").status, 200);
  assert.throws(() => app.owners[1]!.status(), /retired/);
  assert.equal((await fetch(`${app.baseUrl}/api/bilibili-history/status`)).status, 200);
  assert.deepEqual(app.events.filter(event => event.startsWith("publish:")), ["publish:original"]);

  app.setBarrier(async () => { throw new Error("controlled failure after route preparation"); });
  await app.kernel.switch([app.candidate("bad-effect")]);
  app.setBarrier();
  assert.equal(fs.readFileSync(app.statePath, "utf8"), committed);
  assert.equal(originalOwner.job("original-queued").status, 200);
  assert.throws(() => app.owners[2]!.status(), /retired/);
  assert.equal(app.routes.catalogSnapshot().operations.length, 9);

  app.failPublication();
  await assert.rejects(app.kernel.switch([app.candidate("bad-publication")]), /controlled synchronous publication failure/);
  assert.equal(fs.readFileSync(app.statePath, "utf8"), committed);
  assert.equal(originalOwner.status().status, 200);
  assert.throws(() => app.owners[3]!.status(), /retired/);
  assert.equal(app.routes.catalogSnapshot().operations.length, 9);
  assert.deepEqual(app.events.filter(event => event.startsWith("publish:")), ["publish:original"]);
});

test("successful publication and revision rollback resume the latest original job IDs, cursor and queue", { timeout: 15000 }, async t => {
  let release = () => {};
  t.after(() => release());
  const app = await pluginFixture(t);
  await app.kernel.switch([app.candidate("one")]);
  const original = app.owners[0]!;
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  const token = original.pair({ extensionId }, "").body.token;
  assert.equal(typeof token, "string");
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  app.setBarrier(async () => { entered(); await gate; });
  const switching = app.kernel.switch([app.candidate("two")]);
  await started;
  const page = await fetch(`${app.baseUrl}/api/bilibili-history/bridge/page`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jobId: "original-running", pageKey: "latest-page", code: 0,
      items: [{ title: "synthetic viewing record", view_at: 200, history: { business: "archive", bvid: "synthetic-record" } }],
      nextCursor: { max: 2, view_at: 175, business: "archive" } })
  });
  assert.equal(page.status, 200);
  assert.equal((await page.json()).done, false);
  const created = original.createJob({ roleId: "Viewer", since: 100, until: 400 });
  assert.equal(created.status, 202);
  const newest = JSON.parse(fs.readFileSync(app.statePath, "utf8"));
  assert.equal((await fetch(`${app.baseUrl}/api/bilibili-history/status`)).status, 200);
  release();
  await switching;
  app.setBarrier();
  const replacement = app.owners[1]!;
  assert.throws(() => original.status(), /retired/);
  const resumed = replacement.job("original-running").body.job as BilibiliHistoryJob;
  assert.equal(resumed.cursor.view_at, 175);
  assert.equal(resumed.pagesProcessed, 4);
  assert.equal(resumed.summary.itemCount, 1);
  assert.ok(replacement.pair({ extensionId }, "").body.token === token, "replacement must retain the original producer identity");
  assert.equal(replacement.job((created.body.job as BilibiliHistoryJob).id).status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(app.statePath, "utf8")), newest);
  original.close();
  assert.equal(replacement.status().status, 200);

  await app.kernel.switch([app.candidate("one")]);
  const rollback = app.owners[2]!;
  replacement.close();
  assert.equal(rollback.job((created.body.job as BilibiliHistoryJob).id).status, 200);
  assert.ok(rollback.pair({ extensionId }, "").body.token === token, "revision rollback must retain the original producer identity");
  assert.deepEqual(JSON.parse(fs.readFileSync(app.statePath, "utf8")), newest);
  assert.deepEqual(app.events.filter(event => event.startsWith("publish:")), ["publish:one", "publish:two", "publish:one"]);
});

test("publication joins a body admitted by the retiring original owner before resuming its queue", { timeout: 15000 }, async t => {
  let outgoing: http.ClientRequest | undefined;
  t.after(() => outgoing?.destroy());
  const app = await pluginFixture(t);
  await app.kernel.switch([app.candidate("one")]);
  const original = app.owners[0]!;
  let admitted!: () => void;
  let retiring!: () => void;
  const started = new Promise<void>(resolve => { admitted = resolve; });
  const retirementStarted = new Promise<void>(resolve => { retiring = resolve; });
  const nativeAdmit = original.admit.bind(original);
  const nativeClose = original.close.bind(original);
  original.admit = (request, producer) => { const result = nativeAdmit(request, producer); admitted(); return result; };
  original.close = () => { nativeClose(); retiring(); };
  const body = JSON.stringify({ roleId: "Viewer", since: 100, until: 400 });
  const response = new Promise<{ status: number; body: { uncertain?: boolean } }>((resolve, reject) => {
    outgoing = http.request(`${app.baseUrl}/api/bilibili-history/jobs`, { method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, incoming => {
      let text = "";
      incoming.on("data", chunk => { text += chunk.toString(); });
      incoming.on("end", () => resolve({ status: incoming.statusCode!, body: JSON.parse(text) }));
      incoming.on("error", reject);
    });
    outgoing.on("error", reject);
    outgoing.write(body.slice(0, 1));
  });
  await started;
  let completed = false;
  const switching = app.kernel.switch([app.candidate("two")]).then(result => { completed = true; return result; });
  await retirementStarted;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(completed, false, "switch cannot settle while the original operation still owns its body");
  assert.throws(() => app.owners[1]!.status(), /not published/);
  assert.ok(outgoing);
  outgoing.end(body.slice(1));
  const result = await response;
  assert.equal(result.status, 500);
  assert.equal(result.body.uncertain, true);
  await switching;
  assert.equal(app.owners[1]!.status().status, 200);
  assert.equal(JSON.parse(fs.readFileSync(app.statePath, "utf8")).jobs.length, 4);
});

test("post-publication migration failure withdraws its owner without rewriting the queue and a new revision recovers it", async t => {
  const app = await pluginFixture(t);
  const blockedTemporary = `${app.statePath}.${process.pid}.tmp`;
  fs.mkdirSync(blockedTemporary);
  await app.kernel.switch([app.candidate("failed-migration")]);
  assert.equal(fs.readFileSync(app.statePath, "utf8"), app.original);
  assert.throws(() => app.owners[0]!.status(), /retired/);
  assert.equal(app.routes.catalogSnapshot().operations.length, 0);
  assert.equal(app.kernel.current().records.find(record => record.identity.instanceId === "manager:bilibili-history")?.status, "failed");
  assert.equal((await fetch(`${app.baseUrl}/api/bilibili-history/status`)).status, 404);
  fs.rmdirSync(blockedTemporary);
  await app.kernel.switch([app.candidate("recovered")]);
  assert.equal(app.owners[1]!.job("original-running").status, 200);
  const jobs = JSON.parse(fs.readFileSync(app.statePath, "utf8")).jobs;
  assert.deepEqual(jobs.slice(2), app.jobs.slice(2));
  assert.equal(jobs[0].status, "paused");
  assert.equal(app.routes.catalogSnapshot().operations.length, 9);
});
