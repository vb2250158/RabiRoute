import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CompanionWindowTypes } from "./companionWindowTypes.js";
import { CompanionActivity } from "./companionActivity.js";

test("an Agent learns an unknown game from a silent reply; switching and restart reuse its type", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "companion-window-type-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new CompanionWindowTypes(id => path.join(root, id));
  const service = new CompanionActivity({ windowTypes: store,
    presets: [{ id: "adaptive", label: "Auto", labelEn: "Auto", reviewSeconds: 25, replyAgeSeconds: 180, guidance: "observe" }],
    context: async () => "# Example persona", changed: () => {}, reaction: () => {}, deliver: async () => {}, speak: async () => {}, cancelSpeech: async () => {}, save: async () => {} });
  t.after(() => service.dispose());
  const session = (await service.start("one", { requestId: "learn-game", gatewayId: "route", presetId: "adaptive", title: "",
    autoReview: false, voice: false, saveSummary: false })).session!;
  const game = { id: "first", processName: "UnknownClient.exe", title: "New Game  " };
  const sample = (window: typeof game, sequence: number) => {
    const current = service.snapshot("one").session!;
    return service.observe("one", current.id, current.revision, { source: "window", capturedAt: Date.now(), sequence,
      jpeg: Buffer.from([255,216,255,217]).toString("base64"), window }).session!;
  };
  assert.equal(sample(game, 1).activityKind, "uncertain");
  await service.review("one", session.id, session.revision, "");
  await service.reply("one", { sessionId: session.id, revision: session.revision,
    reviewId: service.snapshot("one").session!.review!.id, activityKind: "play", text: "" });
  assert.equal(service.snapshot("one").session!.activityKind, "play");
  await store.flush();
  assert.equal(sample({ id: "browser", processName: "chrome.exe", title: "Work" }, 2).activityKind, "uncertain");
  assert.equal(sample({ ...game, id: "new-instance", title: "New Game" }, 3).activityKind, "play");
  const restored = new CompanionWindowTypes(id => path.join(root, id));
  await restored.load("one"); await restored.load("two");
  assert.equal(restored.classify("one", game), "play");
  assert.equal(restored.classify("two", game), "uncertain");
  assert.equal(restored.classify("one", { ...game, title: "Work" }), "uncertain");
  const file = await fs.readFile(path.join(root, "one", "companion", "window-types.json"), "utf8");
  assert.doesNotMatch(file, /jpeg|reviewId|sessionId|first/);
  await restored.learn("one", game, "other");
  assert.equal(restored.classify("one", game), "other");
});


test("failed learning persistence leaves the prior classification retryable", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "companion-window-write-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new CompanionWindowTypes(id => path.join(root, id));
  const window = { id: "sample", processName: "Example.exe", title: "Example" };
  await store.load("one");
  await fs.mkdir(path.join(root, "one"));
  const blocker = path.join(root, "one", "companion");
  await fs.writeFile(blocker, "file prevents directory creation");
  await assert.rejects(store.learn("one", window, "play"));
  assert.equal(store.classify("one", window), "uncertain");
  assert.equal(await fs.readFile(blocker, "utf8"), "file prevents directory creation");
  await fs.unlink(blocker);
  await store.learn("one", window, "play");
  assert.equal(store.classify("one", window), "play");
  const restored = new CompanionWindowTypes(id => path.join(root, id));
  await restored.load("one");
  assert.equal(restored.classify("one", window), "play");
});


test("bad window rows and duplicate keys preserve raw evidence while healthy learning survives restart", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "companion-window-isolation-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "one", "companion", "window-types.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  const bad = { processName: "Broken.exe", title: "Broken", kind: 4, evidence: "retain" };
  const duplicate = [
    { processName: "Duplicate.exe", title: "Title", kind: "play" },
    { processName: "duplicate.exe", title: " title ", kind: "watch" },
  ];
  const healthy = { processName: "Healthy.exe", title: "Healthy", kind: "watch" };
  const raw = [null, bad, ...duplicate, healthy, { unexpected: true }];
  await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, entries: raw }));
  const store = new CompanionWindowTypes(id => path.join(root, id));
  await store.load("one");
  const window = (processName: string, title: string) => ({ id: "sample", processName, title });
  assert.equal(store.classify("one", window("Healthy.exe", "Healthy")), "watch");
  for (const [processName, title] of [["Broken.exe", "Broken"], ["Duplicate.exe", "Title"]]) {
    assert.equal(store.classify("one", window(processName, title)), "uncertain");
    await assert.rejects(store.learn("one", window(processName, title), "play"), /stored evidence/);
  }
  await store.learn("one", window("Healthy.exe", "Healthy"), "other");
  await store.learn("one", window("New.exe", "New"), "play");
  const persisted = JSON.parse(await fs.readFile(file, "utf8"));
  assert.deepEqual(persisted.entries.slice(0, 4), raw.slice(0, 4));
  assert.deepEqual(persisted.entries[5], raw[5]);
  const restored = new CompanionWindowTypes(id => path.join(root, id));
  await restored.load("one");
  assert.equal(restored.classify("one", window("Healthy.exe", "Healthy")), "other");
  assert.equal(restored.classify("one", window("New.exe", "New")), "play");
  assert.equal(restored.classify("one", window("Duplicate.exe", "Title")), "uncertain");
});
