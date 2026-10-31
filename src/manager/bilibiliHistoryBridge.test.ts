import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BilibiliHistoryBridge } from "./bilibiliHistoryBridge.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { createBilibiliHistoryOperations } from "./bilibiliHistoryOperations.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { registerLanAgentBodyGuard, assertLanAgentBodyAuthority } from "./lanAgentBodyAuthority.js";

function removeOwnedFixture(dir: string): void {
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(dir).startsWith("rabiroute-bili-"));
  fs.rmSync(dir, { recursive: true, force: true });
}

async function fixture(initialState?: unknown, options: { readOnly?: boolean; verifiedRemote?: boolean; enrolledRemote?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-bili-"));
  const rolesRoot = path.join(dir, "data", "roles");
  fs.mkdirSync(path.join(rolesRoot, "YeYu"), { recursive: true });
  const statePath = path.join(dir, "state.json");
  if (initialState) fs.writeFileSync(statePath, `${JSON.stringify(initialState, null, 2)}\n`, "utf8");
  const bridge = new BilibiliHistoryBridge(statePath, rolesRoot, options);
  bridge.publish();
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("bilibili-history", createBilibiliHistoryOperations(bridge));
  const authority = new LanAgentAuthority({ statePath: path.join(dir, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "history-node");
  const server = http.createServer((request, response) => {
    if (options.enrolledRemote) {
      if (evaluateLanAgentRequest(request, authority, true).kind !== "agent") { response.writeHead(401).end(); return; }
      Object.defineProperty(request.socket, "remoteAddress", { configurable: true, value: "192.0.2.10" });
      markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
      registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority(new URL(request.url!, "http://fixture").pathname, body, undefined));
    }
    if (options.verifiedRemote) {
      Object.defineProperty(request.socket, "remoteAddress", { configurable: true, value: "192.0.2.10" });
      markAuthenticatedConnectionRequest(request);
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (!registry.handle(request, url, response)) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await fetch(baseUrl);
  } catch (error) {
    const cause = (error as { cause?: { message?: unknown } }).cause;
    if (String(cause?.message || "").toLowerCase() === "bad port") {
      await new Promise<void>((resolve, reject) => server.close(closeError => closeError ? reject(closeError) : resolve()));
      await registration.dispose(); bridge.close(); removeOwnedFixture(dir);
      return fixture(initialState, options);
    }
    throw error;
  }
  return {
    baseUrl,
    dir,
    bridge,
    registry,
    credential,
    close: async () => { const retirement = registration.dispose(); bridge.close(); await retirement; server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  };
}

test("authenticated remote Manager connection reads browser history status without a local-only gate", async () => {
  const app = await fixture(undefined, { verifiedRemote: true });
  try { assert.equal((await fetch(`${app.baseUrl}/api/bilibili-history/status`)).status, 200); }
  finally { await app.close(); removeOwnedFixture(app.dir); }
});

test("pairs once, persists private daily records, and keeps titles out of global state", async () => {
  const app = await fixture();
  try {
    const pair = await fetch(`${app.baseUrl}/api/bilibili-history/bridge/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ extensionId: "abcdefghijklmnopabcdefghijklmnop" })
    }).then(response => response.json()) as { token: string };
    assert.ok(pair.token);

    const created = await fetch(`${app.baseUrl}/api/bilibili-history/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        roleId: "YeYu",
        since: 1_785_168_000,
        until: 1_785_254_400,
        timezoneOffsetMinutes: -480
      })
    }).then(response => response.json()) as { job: { id: string } };

    const next = await fetch(`${app.baseUrl}/api/bilibili-history/bridge/next`, {
      headers: { authorization: `Bearer ${pair.token}` }
    }).then(response => response.json()) as { job: { id: string } };
    assert.equal(next.job.id, created.job.id);

    const page = await fetch(`${app.baseUrl}/api/bilibili-history/bridge/page`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${pair.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        jobId: created.job.id,
        pageKey: "0:0:",
        code: 0,
        items: [{
          title: "private title must not persist",
          view_at: 1_785_170_000,
          progress: -1,
          duration: 120,
          tag_name: "手机游戏",
          author_name: "private creator",
          author_mid: 42,
          history: { business: "archive", bvid: "BV-private" }
        }, {
          view_at: 1_785_100_000,
          progress: 3,
          duration: 60,
          tag_name: "综合",
          author_mid: 42,
          history: { business: "archive" }
        }],
        nextCursor: { max: 99, view_at: 1_785_100_000, business: "archive" }
      })
    }).then(response => response.json()) as { done: boolean };
    assert.equal(page.done, true);

    const status = await fetch(`${app.baseUrl}/api/bilibili-history/jobs/${created.job.id}`)
      .then(response => response.json()) as {
        job: {
          status: string;
          summary: {
            itemCount: number;
            consumedSeconds: number;
            themeCounts: Record<string, number>;
            authorCounts: Record<string, number>;
            activeDays: Record<string, number>;
          };
          persistence: {
            recordCount: number;
            activeDays: Record<string, number>;
          };
        };
      };
    assert.equal(status.job.status, "completed");
    assert.equal(status.job.summary.itemCount, 1);
    assert.equal(status.job.summary.consumedSeconds, 120);
    assert.equal(status.job.summary.themeCounts["二次元与游戏"], 1);
    assert.equal(status.job.summary.authorCounts["private creator"], 1);
    assert.deepEqual(status.job.summary.activeDays, { "2026-07-28": 1 });
    assert.equal(status.job.persistence.recordCount, 1);
    assert.deepEqual(status.job.persistence.activeDays, { "2026-07-28": 1 });

    const persisted = fs.readFileSync(path.join(app.dir, "state.json"), "utf8");
    assert.doesNotMatch(persisted, /private title|BV-private|SESSDATA|Cookie/i);
    const dailyPath = path.join(app.dir, "data", "roles", "YeYu", "runtime", "bilibili-history", "daily", "2026-07-28.jsonl");
    const daily = fs.readFileSync(dailyPath, "utf8");
    assert.match(daily, /private title|BV-private/);
    assert.doesNotMatch(daily, /SESSDATA|Cookie/i);

    const days = await fetch(`${app.baseUrl}/api/bilibili-history/roles/YeYu/days`).then(response => response.json());
    assert.equal(days.index.totalRecordCount, 1);
    assert.equal(days.index.days[0].date, "2026-07-28");
    const day = await fetch(`${app.baseUrl}/api/bilibili-history/roles/YeYu/days/2026-07-28?limit=10`)
      .then(response => response.json());
    assert.equal(day.total, 1);
    assert.equal(day.records[0].title, "private title must not persist");
  } finally {
    await app.close();
    removeOwnedFixture(app.dir);
  }
});

test("pauses immediately on login expiry or risk control", async () => {
  const app = await fixture();
  try {
    const token = await fetch(`${app.baseUrl}/api/bilibili-history/bridge/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ extensionId: "ponmlkjihgfedcbaponmlkjihgfedcba" })
    }).then(response => response.json()).then(body => body.token as string);
    const jobId = await fetch(`${app.baseUrl}/api/bilibili-history/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roleId: "YeYu", since: 1, until: 2 })
    }).then(response => response.json()).then(body => body.job.id as string);
    await fetch(`${app.baseUrl}/api/bilibili-history/bridge/next`, {
      headers: { authorization: `Bearer ${token}` }
    });
    await fetch(`${app.baseUrl}/api/bilibili-history/bridge/page`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jobId, code: -412, message: "risk control" })
    });
    const status = await fetch(`${app.baseUrl}/api/bilibili-history/jobs/${jobId}`).then(response => response.json());
    assert.equal(status.job.status, "paused");
    assert.match(status.job.lastError, /-412/);
  } finally {
    await app.close();
    removeOwnedFixture(app.dir);
  }
});

test("pauses legacy active jobs that cannot select a durable persona", async () => {
  const app = await fixture({
    version: 1,
    jobs: [{
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      sinceEpoch: 1,
      untilEpoch: 2,
      timezoneOffsetMinutes: -480,
      status: "running",
      cursor: { max: 0, view_at: 0, business: "" },
      pagesProcessed: 0,
      pageDelayMs: 650,
      lastPageKey: "",
      lastError: "",
      summary: {
        itemCount: 0,
        consumedSeconds: 0,
        businessCounts: {},
        tagCounts: {},
        themeCounts: {},
        authorCounts: {},
        activeDays: {}
      }
    }]
  });
  try {
    const status = await fetch(`${app.baseUrl}/api/bilibili-history/jobs/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`).then(response => response.json());
    assert.equal(status.job.status, "paused");
    assert.match(status.job.lastError, /roleId|角色/);
  } finally {
    await app.close();
    removeOwnedFixture(app.dir);
  }
});

test("read-only startup pauses unsafe legacy jobs in memory without rewriting state", async () => {
  const app = await fixture({
    version: 1,
    jobs: [{
      id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      sinceEpoch: 1,
      untilEpoch: 2,
      timezoneOffsetMinutes: -480,
      status: "running",
      cursor: { max: 0, view_at: 0, business: "" },
      pagesProcessed: 0,
      pageDelayMs: 650,
      lastPageKey: "",
      lastError: "",
      summary: {
        itemCount: 0,
        consumedSeconds: 0,
        businessCounts: {},
        tagCounts: {},
        themeCounts: {},
        authorCounts: {},
        activeDays: {}
      }
    }]
  }, { readOnly: true });
  try {
    const status = await fetch(`${app.baseUrl}/api/bilibili-history/jobs/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb`)
      .then(response => response.json());
    assert.equal(status.job.status, "paused");
    const persisted = JSON.parse(fs.readFileSync(path.join(app.dir, "state.json"), "utf8"));
    assert.equal(persisted.jobs[0].status, "running");
    assert.equal(persisted.jobs[0].lastError, "");
  } finally {
    await app.close();
    removeOwnedFixture(app.dir);
  }
});

test("counts the same record once when overlapping pages use different cursors", async () => {
  const app = await fixture();
  try {
    const token = await fetch(`${app.baseUrl}/api/bilibili-history/bridge/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ extensionId: "abcdefghijklmnopabcdefghijklmnop" })
    }).then(response => response.json()).then(body => body.token as string);
    const jobId = await fetch(`${app.baseUrl}/api/bilibili-history/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roleId: "YeYu", since: 100, until: 300, timezoneOffsetMinutes: 0 })
    }).then(response => response.json()).then(body => body.job.id as string);
    await fetch(`${app.baseUrl}/api/bilibili-history/bridge/next`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const item = { title: "one", view_at: 200, history: { business: "archive", bvid: "BV-one" } };
    for (const [pageKey, nextViewAt] of [["page-one", 150], ["page-two", 50]] as const) {
      await fetch(`${app.baseUrl}/api/bilibili-history/bridge/page`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          jobId,
          pageKey,
          code: 0,
          items: [item],
          nextCursor: { max: 1, view_at: nextViewAt, business: "archive" }
        })
      });
    }
    const status = await fetch(`${app.baseUrl}/api/bilibili-history/jobs/${jobId}`).then(response => response.json());
    assert.equal(status.job.summary.itemCount, 1);
    assert.equal(status.job.persistence.recordCount, 1);
    assert.deepEqual(status.job.persistence.activeDays, { "1970-01-01": 1 });
  } finally {
    await app.close();
    removeOwnedFixture(app.dir);
  }
});

test("requires a valid existing persona for durable history jobs", async () => {
  const app = await fixture();
  try {
    const missing = await fetch(`${app.baseUrl}/api/bilibili-history/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ since: 1, until: 2 })
    });
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error, "INVALID_ROLE_ID");

    const unknown = await fetch(`${app.baseUrl}/api/bilibili-history/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roleId: "Unknown", since: 1, until: 2 })
    });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error, "BILIBILI_HISTORY_ROLE_NOT_FOUND");
  } finally {
    await app.close();
    removeOwnedFixture(app.dir);
  }
});

test("rejects a browser origin that does not match the claimed extension id", async () => {
  const app = await fixture();
  try {
    const response = await fetch(`${app.baseUrl}/api/bilibili-history/bridge/pair`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://example.invalid"
      },
      body: JSON.stringify({ extensionId: "abcdefghijklmnopabcdefghijklmnop" })
    });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    const body = await response.json() as { error: string };
    assert.equal(body.error, "EXTENSION_ORIGIN_MISMATCH");
  } finally {
    await app.close();
    removeOwnedFixture(app.dir);
  }
});

test("all declared operations are executable and an enrolled empty remote node reads and creates persona jobs", async () => {
  const app = await fixture(undefined, { enrolledRemote: true });
  const headers = { authorization: `Bearer ${app.credential.token}`, "content-type": "application/json" };
  try {
    assert.equal(app.registry.snapshot()[0]!.routeCount, 9);
    assert.equal((await fetch(`${app.baseUrl}/api/bilibili-history/status`, { headers })).status, 200);
    const created = await fetch(`${app.baseUrl}/api/bilibili-history/jobs`, { method: "POST", headers, body: JSON.stringify({ roleId: "YeYu", since: 100, until: 300 }) });
    assert.equal(created.status, 202); const id = (await created.json()).job.id;
    assert.equal((await fetch(`${app.baseUrl}/api/bilibili-history/jobs/${id}`, { headers })).status, 200);
    assert.equal((await fetch(`${app.baseUrl}/api/bilibili-history/roles/YeYu/days`, { headers })).status, 200);
    const indexPath = path.join(app.dir, "data", "roles", "YeYu", "runtime", "bilibili-history", "index.json");
    assert.equal(fs.existsSync(indexPath), false);
  } finally { await app.close(); removeOwnedFixture(app.dir); }
});

test("OPTIONS preserves every original prefix suffix and producer rejection happens before JSON decoding", async () => {
  const app = await fixture();
  try {
    for (const suffix of ["", "status", "unknown", "unknown/nested", "roles/YeYu/days/2026-08-01"]) {
      const response = await fetch(`${app.baseUrl}/api/bilibili-history/${suffix}`, { method: "OPTIONS" });
      assert.equal(response.status, 204); assert.equal(await response.text(), "");
      assert.equal(response.headers.get("access-control-allow-origin"), null);
      assert.equal(response.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS");
    }
    const invalid = await fetch(`${app.baseUrl}/api/bilibili-history/bridge/page`, { method: "POST", body: "not json" });
    assert.equal(invalid.status, 401); assert.equal((await invalid.json()).error, "INVALID_BRIDGE_TOKEN");
    const oversized = await fetch(`${app.baseUrl}/api/bilibili-history/jobs`, { method: "POST", body: JSON.stringify({ padding: "x".repeat(1024 * 1024) }) });
    assert.equal(oversized.status, 413);
  } finally { await app.close(); removeOwnedFixture(app.dir); }
});

test("a body admitted to the original owner cannot create a job after that owner retires", { timeout: 10000 }, async () => {
  const app = await fixture();
  try {
    let admitted!: () => void; const started = new Promise<void>(resolve => { admitted = resolve; });
    const nativeAdmit = app.bridge.admit.bind(app.bridge);
    app.bridge.admit = (request, producer) => { const result = nativeAdmit(request, producer); admitted(); return result; };
    const body = JSON.stringify({ roleId: "YeYu", since: 100, until: 300 });
    let outgoing!: http.ClientRequest;
    const completed = new Promise<{ status: number; body: any }>((resolve, reject) => {
      outgoing = http.request(`${app.baseUrl}/api/bilibili-history/jobs`, { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, response => {
        let text = ""; response.on("data", chunk => { text += chunk.toString(); }); response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(text) })); response.on("error", reject);
      }); outgoing.on("error", reject); outgoing.write(body.slice(0, 1));
    });
    await started; app.bridge.close(); outgoing.end(body.slice(1)); const response = await completed;
    assert.equal(response.status, 500); assert.equal(response.body.uncertain, true);
    assert.equal(fs.existsSync(path.join(app.dir, "state.json")), false);
  } finally { await app.close(); removeOwnedFixture(app.dir); }
});

test("native case-insensitive read literals preserve mixed case without folding IDs or widening POST/base prefixes", async () => {
  const app = await fixture();
  try {
    const created = await fetch(`${app.baseUrl}/api/bilibili-history/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ roleId: "YeYu", since: 100, until: 300 }) });
    assert.equal(created.status, 202); const id = (await created.json()).job.id;
    const job = await fetch(`${app.baseUrl}/api/bilibili-history/JoBs/${id}`); assert.equal(job.status, 200);
    assert.equal((await job.json()).job.id, id);
    assert.equal((await fetch(`${app.baseUrl}/api/bilibili-history/JOBS/${id.toUpperCase()}`)).status, 404);
    const days = await fetch(`${app.baseUrl}/api/bilibili-history/RoLeS/YeYu/dAyS`); assert.equal(days.status, 200);
    assert.equal((await days.json()).roleId, "YeYu");
    const day = await fetch(`${app.baseUrl}/api/bilibili-history/rOlEs/YeYu/DaYs/2026-08-01`); assert.equal(day.status, 200);
    const row = await day.json(); assert.equal(row.roleId, "YeYu"); assert.equal(row.date, "2026-08-01");
    assert.equal((await fetch(`${app.baseUrl}/api/Bilibili-history/roles/YeYu/days`)).status, 404);
    assert.equal((await fetch(`${app.baseUrl}/API/bilibili-history/roles/YeYu/days`)).status, 404);
    // The all-prefix OPTIONS declaration makes other unmatched methods 405 in the common registrar.
    assert.equal((await fetch(`${app.baseUrl}/api/bilibili-history/STATUS`)).status, 405);
    assert.equal((await fetch(`${app.baseUrl}/api/bilibili-history/JOBS`, { method: "POST", body: JSON.stringify({ roleId: "YeYu", since: 100, until: 300 }) })).status, 405);
    assert.equal((await fetch(`${app.baseUrl}/api/bilibili-history/BRIDGE/pair`, { method: "POST", body: "{}" })).status, 405);
    assert.equal(JSON.parse(fs.readFileSync(path.join(app.dir, "state.json"), "utf8")).jobs.length, 1);
  } finally { await app.close(); removeOwnedFixture(app.dir); }
});
