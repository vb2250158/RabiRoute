import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  TaskCompletionAnnouncementLedger,
  TaskCompletionAnnouncementService,
  TaskCompletionAnnouncementSettingsStore
} from "./taskCompletionAnnouncements.js";

function temporaryRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-task-announcement-"));
}

test("task completion announcements redact before synthesis and deduplicate event ids", async () => {
  const root = temporaryRoot();
  const calls: Array<{ input: string; voice: string }> = [];
  const service = new TaskCompletionAnnouncementService({
    settings: new TaskCompletionAnnouncementSettingsStore(path.join(root, "settings.json")),
    ledger: new TaskCompletionAnnouncementLedger(root),
    resolveModel: async () => "local-tts/gpt-sovits",
    synthesize: async command => {
      calls.push(command);
      return { headers: { "x-rabispeech-playback-job": "job-1" } };
    },
    now: () => new Date("2026-08-24T10:00:00.000Z")
  });

  const first = await service.accept({
    id: "codex:turn-1",
    source: "codex",
    sessionId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    taskName: "整理播报",
    text: "- token: super-secret\n---\n- 已完成配置"
  });
  const duplicate = await service.accept({
    id: "codex:turn-1",
    source: "codex",
    sessionId: "thread-1",
    status: "completed",
    text: "ignored"
  });

  assert.equal(first.spoken, true);
  assert.equal(first.playbackJobId, "job-1");
  assert.equal(duplicate.duplicate, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.input, /token：----/i);
  assert.doesNotMatch(calls[0]!.input, /super-secret/);
  assert.match(calls[0]!.input, /----\s*；\s*已完成配置/);
  assert.equal(service.records(1)[0]?.textHash.length, 64);
  assert.equal(fs.existsSync(path.join(root, "events", "current.jsonl")), false);
  assert.equal(fs.readFileSync(path.join(root, "events", "2026-08-24.jsonl"), "utf8").trim().split("\n").length, 1);
  const index = JSON.parse(fs.readFileSync(path.join(root, "event-index.json"), "utf8")) as Record<string, unknown>;
  assert.equal(index.recordClass, "task-completion-announcement-metadata");
  assert.equal(index.sourceOfTruth, "events/YYYY-MM-DD.jsonl");
  assert.equal(index.action, "rotate");
  assert.equal(index.sourceRetention, "retained");
});

test("disabled DSH events are retained as ignored metadata without synthesis", async () => {
  const root = temporaryRoot();
  let calls = 0;
  const service = new TaskCompletionAnnouncementService({
    settings: new TaskCompletionAnnouncementSettingsStore(path.join(root, "settings.json")),
    ledger: new TaskCompletionAnnouncementLedger(root),
    resolveModel: async () => "local-tts/gpt-sovits",
    synthesize: async () => {
      calls += 1;
      return { headers: {} };
    }
  });
  const result = await service.accept({
    id: "dsh:turn-1",
    source: "dsh",
    sessionId: "dsh-session",
    status: "completed",
    text: "DSH summary"
  });

  assert.equal(result.spoken, false);
  assert.equal(result.reason, "source_disabled");
  assert.equal(calls, 0);
  assert.equal(service.records(1)[0]?.decision, "ignored");
});
