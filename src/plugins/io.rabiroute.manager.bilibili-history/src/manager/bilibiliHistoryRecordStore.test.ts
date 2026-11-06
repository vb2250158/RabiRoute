import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BilibiliHistoryRecordStore } from "./bilibiliHistoryRecordStore.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-bili-records-"));
  const rolesRoot = path.join(root, "data", "roles");
  fs.mkdirSync(path.join(rolesRoot, "YeYu"), { recursive: true });
  return {
    root,
    store: new BilibiliHistoryRecordStore(rolesRoot),
    close: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

function epoch(value: string): number {
  return Math.floor(Date.parse(value) / 1000);
}

test("persists every item into private local-date shards and rebuilds the index in memory on read", () => {
  const app = fixture();
  try {
    const result = app.store.persist("YeYu", [{
      title: "first private title",
      uri: "https://www.bilibili.com/video/BV-first",
      author_name: "creator one",
      author_mid: 11,
      view_at: epoch("2026-08-08T23:59:00+08:00"),
      progress: 59,
      duration: 60,
      tag_name: "手机游戏",
      history: { business: "archive", bvid: "BV-first" },
      Cookie: "must not persist"
    }, {
      title: "second private title",
      view_at: epoch("2026-08-09T00:01:00+08:00"),
      progress: -1,
      duration: 120,
      history: { business: "archive", bvid: "BV-second" }
    }], {
      jobId: "job-one",
      capturedAt: "2026-08-10T00:00:00.000Z",
      timezoneOffsetMinutes: -480
    });

    assert.equal(result.acceptedRecordCount, 2);
    assert.equal(result.insertedRecordCount, 2);
    assert.deepEqual(result.days.map(day => [day.date, day.recordCount]), [
      ["2026-08-08", 1],
      ["2026-08-09", 1]
    ]);
    const firstDay = app.store.readDay("YeYu", "2026-08-08");
    assert.equal(firstDay.length, 1);
    assert.equal(firstDay[0].title, "first private title");
    assert.equal(firstDay[0].history?.bvid, "BV-first");
    assert.deepEqual(firstDay[0].sourceJobIds, ["job-one"]);
    assert.doesNotMatch(JSON.stringify(firstDay[0]), /Cookie|must not persist|SESSDATA|bili_jct/i);

    const index = JSON.parse(fs.readFileSync(app.store.indexPath("YeYu"), "utf8"));
    assert.equal(index.recordClass, "private-bilibili-history-date-shards");
    assert.equal(index.action, "date-partition");
    assert.equal(index.totalRecordCount, 2);
    fs.unlinkSync(app.store.indexPath("YeYu"));
    const rebuilt = app.store.readIndex("YeYu");
    assert.equal(rebuilt.totalRecordCount, 2);
    assert.equal(fs.existsSync(app.store.indexPath("YeYu")), false);
  } finally {
    app.close();
  }
});

test("overlapping jobs update the same viewing record without duplicating it", () => {
  const app = fixture();
  try {
    const viewedAt = epoch("2026-08-08T12:00:00+08:00");
    const original = {
      title: "private title",
      view_at: viewedAt,
      progress: 10,
      duration: 100,
      history: { business: "archive", bvid: "BV-overlap" }
    };
    app.store.persist("YeYu", [original], {
      jobId: "job-one",
      capturedAt: "2026-08-08T04:01:00.000Z",
      timezoneOffsetMinutes: -480
    });
    const repeated = app.store.persist("YeYu", [{ ...original, progress: 90 }], {
      jobId: "job-two",
      capturedAt: "2026-08-08T04:02:00.000Z",
      timezoneOffsetMinutes: -480
    });

    assert.equal(repeated.acceptedRecordCount, 1);
    assert.equal(repeated.insertedRecordCount, 0);
    assert.equal(repeated.updatedRecordCount, 1);
    const records = app.store.readDay("YeYu", "2026-08-08");
    assert.equal(records.length, 1);
    assert.equal(records[0].progress, 90);
    assert.equal(records[0].firstCapturedAt, "2026-08-08T04:01:00.000Z");
    assert.equal(records[0].lastCapturedAt, "2026-08-08T04:02:00.000Z");
    assert.deepEqual(records[0].sourceJobIds, ["job-one", "job-two"]);
  } finally {
    app.close();
  }
});

test("fails closed for missing personas and corrupt existing shards", () => {
  const app = fixture();
  try {
    assert.throws(() => app.store.persist("MissingRole", [], {
      jobId: "job-one",
      timezoneOffsetMinutes: -480
    }), /BILIBILI_HISTORY_ROLE_NOT_FOUND/);

    const filePath = app.store.dailyFilePath("YeYu", "2026-08-08");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "not-json\n", "utf8");
    assert.throws(() => app.store.persist("YeYu", [{
      title: "would otherwise overwrite",
      view_at: epoch("2026-08-08T12:00:00+08:00"),
      history: { business: "archive", bvid: "BV-corrupt" }
    }], {
      jobId: "job-two",
      timezoneOffsetMinutes: -480
    }), /Invalid Bilibili history JSONL/);
    assert.equal(fs.readFileSync(filePath, "utf8"), "not-json\n");
  } finally {
    app.close();
  }
});

test("resolves the configured persona root at write time", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-bili-dynamic-root-"));
  try {
    const firstRolesRoot = path.join(root, "first", "roles");
    const secondRolesRoot = path.join(root, "second", "roles");
    fs.mkdirSync(path.join(firstRolesRoot, "YeYu"), { recursive: true });
    fs.mkdirSync(path.join(secondRolesRoot, "YeYu"), { recursive: true });
    let configuredRolesRoot = firstRolesRoot;
    const store = new BilibiliHistoryRecordStore(() => configuredRolesRoot);
    configuredRolesRoot = secondRolesRoot;
    store.persist("YeYu", [{
      title: "stored in current configured root",
      view_at: epoch("2026-08-08T12:00:00+08:00"),
      history: { business: "archive", bvid: "BV-dynamic-root" }
    }], { jobId: "job-one", timezoneOffsetMinutes: -480 });

    assert.equal(fs.existsSync(path.join(firstRolesRoot, "YeYu", "runtime", "bilibili-history", "daily", "2026-08-08.jsonl")), false);
    assert.equal(fs.existsSync(path.join(secondRolesRoot, "YeYu", "runtime", "bilibili-history", "daily", "2026-08-08.jsonl")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
