import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BilibiliHistoryBridge } from "./bilibiliHistoryBridge.js";

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-bili-"));
  const bridge = new BilibiliHistoryBridge(path.join(dir, "state.json"));
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (!bridge.handle(request, url, response)) response.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    dir,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  };
}

test("pairs once, resumes cursor jobs, aggregates without persisting titles or credentials", async () => {
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
        };
      };
    assert.equal(status.job.status, "completed");
    assert.equal(status.job.summary.itemCount, 1);
    assert.equal(status.job.summary.consumedSeconds, 120);
    assert.equal(status.job.summary.themeCounts["二次元与游戏"], 1);
    assert.equal(status.job.summary.authorCounts["private creator"], 1);
    assert.deepEqual(status.job.summary.activeDays, { "2026-07-28": 1 });

    const persisted = fs.readFileSync(path.join(app.dir, "state.json"), "utf8");
    assert.doesNotMatch(persisted, /private title|BV-private|SESSDATA|Cookie/i);
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
      body: JSON.stringify({ since: 1, until: 2 })
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
