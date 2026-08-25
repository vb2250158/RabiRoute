import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkEndEventLedger, WorkEndEventService } from "./workEndEvents.js";

function temporaryRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-work-ended-"));
}

test("work-ended is persisted and published even when announcement is disabled", async () => {
  const root = temporaryRoot();
  const published: unknown[] = [];
  const service = new WorkEndEventService({
    ledger: new WorkEndEventLedger(root),
    publish: event => published.push(event),
    announce: async () => ({ handled: false, spoken: false, reason: "globally_disabled" }),
    now: () => new Date("2026-08-25T08:00:00.000Z")
  });

  const receipt = await service.accept({
    id: "codex:turn-1",
    source: "codex",
    sessionId: "thread-1",
    turnId: "turn-1",
    personaId: "YeYu",
    status: "completed",
    summary: "已完成桌宠事件接入"
  });

  assert.equal(receipt.accepted, true);
  assert.equal(receipt.consumers.announcement?.spoken, false);
  assert.equal(published.length, 1);
  assert.equal(service.records(1)[0]?.personaId, "YeYu");
  assert.equal(service.records(1)[0]?.summary, "已完成桌宠事件接入");
  assert.equal(fs.existsSync(path.join(root, "events", "2026-08-25.jsonl")), true);
});
test("work-ended deduplicates before publishing or invoking consumers", async () => {
  const root = temporaryRoot();
  let published = 0;
  let announced = 0;
  const service = new WorkEndEventService({
    ledger: new WorkEndEventLedger(root),
    publish: () => { published += 1; },
    announce: async () => {
      announced += 1;
      return { handled: true, spoken: true };
    }
  });
  const event = {
    id: "codex:turn-2",
    source: "codex",
    sessionId: "thread-1",
    status: "completed" as const,
    summary: "done"
  };

  const first = await service.accept(event);
  const second = await service.accept(event);

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(published, 1);
  assert.equal(announced, 1);
});

test("work-ended rejects invalid status and sanitizes identifiers", async () => {
  const service = new WorkEndEventService({
    ledger: new WorkEndEventLedger(temporaryRoot()),
    publish: () => {},
    announce: async () => ({ handled: false })
  });

  await assert.rejects(() => service.accept({
    source: "codex",
    sessionId: "thread-1",
    status: "stopped" as "completed",
    summary: "done"
  }), /status/);
});
