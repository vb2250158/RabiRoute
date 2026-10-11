import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CompanionContinuationStore } from "./companionContinuation.js";
import { CompanionActivity } from "./companionActivity.js";

test("desktop recovery retains only explicit intent across a new Manager and clears manual pauses", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "companion-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new CompanionContinuationStore(root);
  const activity = new CompanionActivity({ presets: [{ id: "adaptive", label: "auto", labelEn: "Auto", reviewSeconds: 25, replyAgeSeconds: 30, guidance: "observe" }],
    changed: () => {}, reaction: () => {}, save: async () => {}, cancelSpeech: async () => {}, speak: async () => {}, deliver: async () => {} });
  t.after(() => activity.dispose());
  const session = (await activity.start("one", { requestId: "first-start", gatewayId: "local-route", presetId: "adaptive", title: "", autoReview: true, voice: false, saveSummary: false, observationOwner: "desktop" })).session!;
  await store.save(session);
  const restored = await new CompanionContinuationStore(root).read("one");
  assert.equal(restored?.gatewayId, "local-route");
  assert.equal(restored?.observationOwner, "desktop");
  const raw = JSON.parse(await fs.readFile(path.join(root, "one.json"), "utf8"));
  assert.deepEqual(Object.keys(raw.intent).sort(), ["autoReview", "gatewayId", "observationOwner", "presetId", "saveSummary", "title", "voice"]);
  assert.equal(await store.read("two"), null);
  await store.clear("one");
  assert.equal(await new CompanionContinuationStore(root).read("one"), null);
  await assert.rejects(store.save({ ...session, roleId: "../outside" }), /persona/);
  await fs.writeFile(path.join(root, "one.json"), "x".repeat(4097));
  assert.equal(await store.read("one"), null);
});
