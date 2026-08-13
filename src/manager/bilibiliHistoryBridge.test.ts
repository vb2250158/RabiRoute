import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BilibiliHistoryBridge } from "./bilibiliHistoryBridge.js";

async function fixture(initialState?: unknown, options: { readOnly?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-bili-"));
  const rolesRoot = path.join(dir, "data", "roles");
  fs.mkdirSync(path.join(rolesRoot, "YeYu"), { recursive: true });
  const statePath = path.join(dir, "state.json");
  if (initialState) fs.writeFileSync(statePath, `${JSON.stringify(initialState, null, 2)}\n`, "utf8");
  const bridge = new BilibiliHistoryBridge(statePath, rolesRoot, options);
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (!bridge.handle(request, url, response)) response.end();
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
      fs.rmSync(dir, { recursive: true, force: true });
      return fixture(initialState, options);
    }
    throw error;
  }
  return {
    baseUrl,
    dir,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  };
}

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
    fs.rmSync(app.dir, { recursive: true, force: true });
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
    fs.rmSync(app.dir, { recursive: true, force: true });
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
    assert.match(status.job.lastError, /roleId|人格/);
  } finally {
    await app.close();
    fs.rmSync(app.dir, { recursive: true, force: true });
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
    fs.rmSync(app.dir, { recursive: true, force: true });
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
    fs.rmSync(app.dir, { recursive: true, force: true });
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
    fs.rmSync(app.dir, { recursive: true, force: true });
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
    fs.rmSync(app.dir, { recursive: true, force: true });
  }
});
