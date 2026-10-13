import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { GatewayStatusSnapshotService } from "../manager/gatewayStatusSnapshot.js";
import { testNapcatHealth, type NapcatManagerContext } from "./napcatManager.js";

const settled = () => new Promise<void>(resolve => setImmediate(resolve));

test("NapCat WS health requires a fresh snapshot owned by the current Gateway process", async t => {
  const now = Date.now();
  const startedAt = new Date(now - 10_000).toISOString();
  const refreshedAt = new Date(now - 1_000).toISOString();
  const instance = { id: "bot", botUserId: "10000", gatewayPort: 8789,
    httpUrl: "http://onebot.invalid", webuiUrl: "http://webui.invalid", webuiToken: "test-only" };
  const definition = { id: "route", gatewayPort: 8789, napcatInstances: [instance] };
  const gatewayProcess = { pid: 2002, killed: false, exitCode: null };
  let status: Record<string, unknown>;
  let currentProcess: typeof gatewayProcess | null = gatewayProcess;
  const ctx: NapcatManagerContext = {
    rootDir: "", getRuntimes: () => [{ definition, process: currentProcess, startedAt, status }],
    normalizeNapCatInstances: () => [instance], appendLog: () => undefined,
    checkHttpEndpoint: async () => false
  };
  // No real HTTP, QQ, local configuration, WebUI login, process inspection or lifecycle operations.
  t.mock.method(fs, "existsSync", () => false);
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    assert.ok(url === `${instance.httpUrl}/get_status` || url === `${instance.httpUrl}/get_login_info`);
    return new Response(JSON.stringify({ status: "ok", retcode: 0,
      data: url.endsWith("/get_status") ? { online: true, good: true } : { user_id: "10000", nickname: "Fixture" }
    }), { status: 200 });
  });
  const request = { gatewayId: "route", instanceId: "bot", requireWsConnection: true,
    inspectProcesses: false, readWebuiLoginInfo: false };
  const validStatus = () => ({ pid: 2002, updatedAt: refreshedAt,
    napcatInstances: { bot: { connected: true } },
    gatewayStatusSnapshot: { state: "ready", refreshedAt, fresh: true } });

  await t.test("failed refresh retains old UI data but cannot mark a new process healthy", async () => {
    let clock = now - 20_000;
    let fail = false;
    const snapshots = new GatewayStatusSnapshotService({ now: () => clock, load: async () => {
      if (fail) throw new Error("storage unavailable");
      return { pid: 1001, updatedAt: new Date(clock).toISOString(), napcatInstances: { bot: { connected: true } } };
    } });
    try {
      snapshots.read("route", "fixture");
      await settled();
      fail = true;
      clock = now;
      snapshots.read("route", "fixture");
      await settled();
      status = snapshots.read("route", "fixture");
      assert.equal((status.napcatInstances as { bot: { connected: boolean } }).bot.connected, true);
      assert.equal((status.gatewayStatusSnapshot as { state: string }).state, "stale");
      const health = await testNapcatHealth(ctx, request);
      assert.equal(health.ok, false);
      assert.equal(health.state, "onebot-not-ready");
      assert.equal(instance.botUserId, "10000", "read-only health must preserve the binding");
    } finally { snapshots.stop(); }
  });

  await t.test("current-process snapshot remains usable across a sparse supervisor refresh and recovers", async () => {
    let clock = now;
    let finish!: (value: Record<string, unknown>) => void;
    const snapshots = new GatewayStatusSnapshotService({ now: () => clock, load: async () =>
      new Promise(resolve => { finish = resolve; }) });
    const ownedStatus = () => ({ pid: 2002, updatedAt: new Date(clock).toISOString(),
      napcatInstances: { bot: { connected: true } } });
    try {
      snapshots.read("route", "fixture");
      await settled();
      finish(ownedStatus());
      await settled();
      status = snapshots.read("route", "fixture");
      assert.equal((await testNapcatHealth(ctx, request)).ok, true);
      clock += 30_000;
      status = snapshots.read("route", "fixture");
      assert.equal((status.gatewayStatusSnapshot as { state: string }).state, "refreshing");
      assert.equal((await testNapcatHealth(ctx, request)).ok, true);
      await settled();
      clock += 30_001;
      status = snapshots.read("route", "fixture");
      assert.equal((await testNapcatHealth(ctx, request)).ok, false, "overdue reads cannot preserve WS health forever");
      finish(ownedStatus());
      await settled();
      status = snapshots.read("route", "fixture");
      assert.equal((await testNapcatHealth(ctx, request)).ok, true);
    } finally { snapshots.stop(); }
  });

  for (const state of ["warming", "stale", "stopped", "unknown"]) {
    await t.test(`snapshot state ${state} is not WS evidence`, async () => {
      status = { ...validStatus(), gatewayStatusSnapshot: { state, refreshedAt, fresh: true } };
      assert.equal((await testNapcatHealth(ctx, request)).ok, false);
    });
  }
  for (const [label, snapshot] of [
    ["refresh error", { state: "refreshing", refreshedAt, fresh: true, error: "storage unavailable" }],
    ["expired freshness", { state: "ready", refreshedAt, fresh: false }],
    ["missing freshness", { state: "ready", refreshedAt }],
    ["missing refresh time", { state: "ready", fresh: true }],
    ["invalid refresh time", { state: "ready", refreshedAt: "invalid", fresh: true }],
    ["refresh predates current process", { state: "ready", refreshedAt: new Date(now - 20_000).toISOString(), fresh: true }]
  ] as const) {
    await t.test(label, async () => {
      status = { ...validStatus(), gatewayStatusSnapshot: snapshot };
      assert.equal((await testNapcatHealth(ctx, request)).ok, false);
    });
  }
  for (const [label, patch] of [
    ["previous process PID", { pid: 1001 }],
    ["missing writer PID", { pid: undefined }],
    ["writer update predates current process", { updatedAt: new Date(now - 20_000).toISOString() }],
    ["invalid writer update", { updatedAt: "invalid" }],
    ["other instance cannot supply connection", { napcatInstances: { other: { connected: true } }, napcat: { connected: true } }]
  ] as const) {
    await t.test(label, async () => {
      status = { ...validStatus(), ...patch };
      assert.equal((await testNapcatHealth(ctx, request)).ok, false);
    });
  }
  await t.test("missing runtime start time cannot prove process freshness", async () => {
    status = validStatus();
    const noStartContext = { ...ctx, getRuntimes: () => [{ definition, process: gatewayProcess, status }] };
    assert.equal((await testNapcatHealth(noStartContext, request)).ok, false);
  });
  await t.test("refresh time can fence a writer that has no updatedAt field", async () => {
    status = { ...validStatus(), updatedAt: undefined };
    assert.equal((await testNapcatHealth(ctx, request)).ok, true);
  });
  await t.test("exited or killed process cannot supply connection", async () => {
    status = validStatus();
    gatewayProcess.killed = true;
    assert.equal((await testNapcatHealth(ctx, request)).ok, false);
    gatewayProcess.killed = false;
    const exitedContext = { ...ctx, getRuntimes: () => [{ definition, process: { ...gatewayProcess, exitCode: 0 }, startedAt, status }] };
    assert.equal((await testNapcatHealth(exitedContext, request)).ok, false);
  });
  await t.test("stopped Gateway cannot supply connection", async () => {
    status = validStatus();
    currentProcess = null;
    assert.equal((await testNapcatHealth(ctx, request)).ok, false);
    currentProcess = gatewayProcess;
  });
  for (const state of ["ready", "refreshing"]) {
    await t.test(`current connected WS remains healthy while snapshot is ${state}`, async () => {
      status = { ...validStatus(), gatewayStatusSnapshot: { state, refreshedAt, fresh: true } };
      const health = await testNapcatHealth(ctx, request);
      assert.equal(health.ok, true);
      assert.equal(health.state, "ready");
    });
  }
  await t.test("HTTP-only inspection does not require WS snapshot evidence", async () => {
    status = { napcatInstances: { bot: { connected: true } }, gatewayStatusSnapshot: { state: "stale", error: "storage unavailable" } };
    currentProcess = null;
    const health = await testNapcatHealth(ctx, { ...request, requireWsConnection: false });
    assert.equal(health.ok, true);
    assert.equal(health.state, "ready");
  });
});
