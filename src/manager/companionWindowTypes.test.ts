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
