import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { XiaomiHomeEventLedger } from "./eventLedger.js";
import { installDataMutationAuditSink, type RecordedDataMutationAudit } from "../../observability/dataMutationAudit.js";

test("event ledger preserves ordered records and audits without exposing event text", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiaomi-ledger-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const records: RecordedDataMutationAudit[] = [];
  t.after(installDataMutationAuditSink(record => records.push(record)));
  const ledger = new XiaomiHomeEventLedger(() => root, 2);
  const event = { id: "event-a", kind: "sensor_alert" as const, resourceId: "home:ha:sensor.test", resourceName: "private device", occurredAt: "2026-09-29T00:00:00Z", summary: "private event" };
  const first = ledger.append("example", event);
  const second = ledger.append("example", { ...event, id: "event-b" });
  await assert.rejects(ledger.append("example", { ...event, id: "event-c" }), /queue full/);
  await Promise.all([first, second]);
  const rows = (await fs.readFile(path.join(root, "xiaomi-home-events.jsonl"), "utf8")).trim().split("\n").map(row => JSON.parse(row));
  assert.deepEqual(rows.map(row => row.id), ["event-a", "event-b"]);
  assert.equal(rows[0].summary, event.summary);
  assert.equal(rows[0].time, Date.parse(event.occurredAt) / 1000);
  await assert.rejects(ledger.append("../invalid", event));
  await assert.rejects(ledger.append("example", { ...event, summary: "x".repeat(256 * 1024) }), /too large/);
  assert.equal(records.filter(record => record.outcome === "committed").length, 2);
  assert.equal(JSON.stringify(records).includes(event.summary), false);
  assert.equal(JSON.stringify(records).includes(root), false);
});

test("event ledger rejects absent role storage and recovers its queue after failure", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiaomi-ledger-failure-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, "role");
  const ledger = new XiaomiHomeEventLedger(() => target, 1);
  const event = { id: "event-a", kind: "sensor_alert" as const, resourceId: "home:ha:sensor.test", resourceName: "device", occurredAt: "2026-09-29T00:00:00Z", summary: "event" };
  await assert.rejects(ledger.append("example", event), /ENOENT/);
  await assert.rejects(fs.stat(target), /ENOENT/);
  await fs.mkdir(target);
  await ledger.append("example", event);
  assert.equal(JSON.parse(await fs.readFile(path.join(target, "xiaomi-home-events.jsonl"), "utf8")).id, event.id);
});
