import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCompanionSceneRules } from "./companionScene.js";
import { CompanionActivity, lastCompanionSummary, readCompanionPresets, recordCompanionInteraction, saveCompanionSummary, type CompanionPorts } from "./companionActivity.js";
import { CompanionWindowTypes } from "./companionWindowTypes.js";
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
const start = { requestId: "request-first", gatewayId: "route", presetId: "adaptive", title: "", autoReview: false, voice: true, saveSummary: false, observationOwner: "desktop" as const };
const catalog = readCompanionPresets(JSON.parse(readFileSync("packages/rabi-companion/presets.json", "utf8")));

test("companion reads microphone ASR for the frozen frame interval without a second recognizer",async t=>{
 const f=fixture(t,{transcripts:async(role,from,to)=>{
  assert.equal(role,"one");assert.equal(from,1_000_000);assert.equal(to,1_002_000);
  return {events:[{id:"mic",startedAt:1_000_200,endedAt:1_000_500,source:"microphone",text:"my short sentence"},
   {id:"playback",startedAt:1_000_700,endedAt:1_001_000,source:"systemAudio",text:"video dialogue"}]};
 }});
 const s=(await f.service.start("one",start)).session!;f.advance(2000);f.observe();
 await f.service.review("one",s.id,s.revision,"");
 assert.match(f.delivered[0],/my short sentence/);assert.doesNotMatch(f.delivered[0],/video dialogue/);
 assert.match(f.delivered[0],/"microphone":\{"status":"transcribed"/);
});
function fixture(t: import("node:test").TestContext, overrides: Partial<CompanionPorts> = {}) {
  let now = 1_000_000;
  const cancelled: string[] = [], spoken: string[] = [], delivered: string[] = [];
  const service = new CompanionActivity({ presets: readCompanionPresets({ presets: [{ id: "adaptive", label: "自适应", labelEn: "Adaptive", reviewSeconds: 25, replyAgeSeconds: 30, guidance: "observe" }] }),
    now: () => now, changed: () => {}, reaction: () => {}, context: async () => "fixture persona", save: async () => {}, cancelSpeech: async scope => { cancelled.push(scope); },
    speak: async (_s, text) => { spoken.push(text); }, deliver: async (_s, review) => { delivered.push(review.text); }, ...overrides });
  t.after(() => service.dispose());
  const observe = (sequence = 1, frame = jpeg) => { const s = service.snapshot("one").session!; return service.observe("one", s.id, s.revision,
    { sequence, capturedAt: now, source: "window", jpeg: frame, window: { id: "123:45", title: "Episode 1", processName: "player.exe" } }); };
  const command = (action: "stop" | "pause" | "resume" | "interrupt" | "seek", positionSeconds?: number) => { const s = service.snapshot("one").session!; return service.command("one", { sessionId: s.id, revision: s.revision, action, positionSeconds }); };
  return { service, observe, command, cancelled, spoken, delivered, advance: (ms: number) => { now += ms; } };
}
test("menu start is explicit, idempotent, role isolated and owns no saved recording", async t => {
  const f = fixture(t); const first = await f.service.start("one", start);
  assert.deepEqual(await f.service.start("one", start), first);
  assert.equal(first.session?.observationOwner, "desktop"); assert.equal(first.session?.saveSummary, false);
  assert.equal(f.service.snapshot("two").session, null);
  await assert.rejects(f.service.start("two", { ...start, requestId: "another-request" }), /结束/);
});

test("local scene evidence immediately updates animation context and survives an uncertain reply", async t => {
  const f = fixture(t, { sceneRules: readCompanionSceneRules({ rules: [{ kind: "watch", processPattern: "^player[.]exe$" }] }) });
  const s = (await f.service.start("one", start)).session!;
  assert.equal(f.observe().session!.activityKind, "watch");
  await f.service.review("one", s.id, s.revision, "");
  const reviewId = f.service.snapshot("one").session!.review!.id;
  await f.service.reply("one", { sessionId: s.id, revision: s.revision, reviewId, text: "", activityKind: "uncertain" });
  assert.equal(f.service.snapshot("one").session!.activityKind, "watch");
  await f.command("interrupt");
  assert.equal(f.service.snapshot("one").session!.activityKind, "uncertain");
});
test("switching browser pages atomically fences the old review without waiting for speech cancellation", async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(t, { sceneRules: readCompanionSceneRules({ rules: [{ kind: "watch", titlePattern: "bilibili" }] }),
    cancelSpeech: async () => gate });
  const s = (await f.service.start("one", start)).session!;
  const sample = (title: string, sequence: number) => {
    const current = f.service.snapshot("one").session!;
    return f.service.observe("one", current.id, current.revision, { sequence, capturedAt: 1_000_000,
      source: "window", jpeg, window: { id: "browser", processName: "chrome.exe", title } });
  };
  sample("Episode 1 bilibili", 1);
  await f.service.review("one", s.id, s.revision, "");
  const oldReview = f.service.snapshot("one").session!.review!;
  const second = sample("Episode 2 bilibili", 2).session!;
  release(); // Cancellation completion must not be required by observe().
  assert.equal(second.activityKind, "watch"); assert.equal(second.revision, 2);
  assert.equal(second.review, null); assert.equal(second.lastObservationAt, 1_000_000);
  await assert.rejects(f.service.reply("one", { sessionId: s.id, revision: s.revision,
    reviewId: oldReview.id, text: "old" }), /版本/);
  assert.equal(sample("Search page", 3).session!.activityKind, "uncertain");
  release();
});
test("window switch fences the old frame, Agent reply and only its speech scope", async t => {
  const f = fixture(t); const s = (await f.service.start("one", start)).session!; f.observe();
  await f.service.review("one", s.id, s.revision, ""); const review = f.service.snapshot("one").session!.review!;
  assert.equal(f.service.frameFor("one", review.id).length, 4);
  await f.command("interrupt");
  assert.throws(() => f.service.frameFor("one", review.id), /expired/);
  await assert.rejects(f.service.reply("one", { sessionId: s.id, revision: s.revision, reviewId: review.id, text: "old" }), /版本/);
  assert.deepEqual(f.cancelled, [`companion.${s.id}.1`]); assert.deepEqual(f.spoken, []);
});
test("out-of-order and stale observations cannot replace a newer frame", async t => {
  const f = fixture(t); await f.service.start("one", start); const newer = f.observe(5);
  assert.deepEqual(f.observe(1), newer);
  const s = newer.session!;
  assert.throws(() => f.service.observe("one", s.id, s.revision, { sequence: 6, capturedAt: 1, source: "window", jpeg }), /stale/);
  await f.command("pause"); f.observe();
  assert.equal(f.service.snapshot("one").session!.status, "paused");
});
test("invalid seek does not invalidate the current session", async t => {
  const f = fixture(t); await f.service.start("one", start); f.observe(); const before = f.service.snapshot("one");
  await assert.rejects(f.command("seek", -1), /position/); assert.deepEqual(f.service.snapshot("one"), before);
});
test("adaptation accepts a silent classification and suppresses stale or duplicate speech", async t => {
  const f = fixture(t); const s = (await f.service.start("one", start)).session!; f.observe();
  await f.service.review("one", s.id, s.revision, ""); const id = f.service.snapshot("one").session!.review!.id;
  await f.service.reply("one", { sessionId: s.id, revision: s.revision, reviewId: id, text: "", activityKind: "watch" });
  assert.equal(f.service.snapshot("one").session!.activityKind, "watch"); assert.deepEqual(f.spoken, []);
  await f.service.reply("one", { sessionId: s.id, revision: s.revision, reviewId: id, text: "duplicate" }); assert.deepEqual(f.spoken, []);
  await f.service.review("one", s.id, s.revision, ""); const expired = f.service.snapshot("one").session!.review!.id; f.advance(31_000);
  await assert.rejects(f.service.reply("one", { sessionId: s.id, revision: s.revision, reviewId: expired, text: "late" }), /过期/);
});
test("explicit discussion retains a fresh desktop frame while cancelling an earlier scope", async t => {
  const f = fixture(t); const s = (await f.service.start("one", start)).session!; f.observe(20);
  const after = await f.service.review("one", s.id, s.revision, "刚才发生了什么");
  assert.equal(after.session!.revision, 2); assert.equal(f.service.frameFor("one", after.session!.review!.id).length, 4);
  assert.equal(f.observe(1).session!.lastObservationAt, 1_000_000);
});
test("delivery backpressure is bounded and stop discards a late delivery completion", async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(t, { deliver: async () => gate }); const s = (await f.service.start("one", start)).session!; f.observe();
  const pending = f.service.review("one", s.id, s.revision, "");
  await assert.rejects(f.service.review("one", s.id, s.revision, "hello"), /上一段/);
  await f.command("stop"); release(); await pending; assert.equal(f.service.snapshot("one").session!.review, null);
});
test("opt-in summary survives restart without raw frame persistence", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "companion-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const f = fixture(t, { save: s => saveCompanionSummary(root, s) }); await f.service.start("one", { ...start, saveSummary: true }); f.observe();
  await f.command("stop"); const last = await lastCompanionSummary(root);
  assert.equal(last!.status, "ended"); assert.equal("jpeg" in last!, false);
  assert.equal((await fs.readdir(path.join(root, "companion", "sessions"))).length, 1);
  assert.equal((await fs.readFile(path.join(root, "companion", "sessions", `${last!.id}.json`), "utf8")).includes(jpeg), false);
});

test("each review loads fresh persona context and missing context never dispatches generic guidance", async t => {
  let persona = "specific persona version one";
  const f = fixture(t, { context: async () => persona });
  const session = (await f.service.start("one", start)).session!;
  f.observe();
  await f.service.review("one", session.id, session.revision, "");
  assert.match(f.delivered[0], /specific persona version one/);
  persona = "specific persona version two";
  await f.service.review("one", session.id, session.revision, "");
  assert.match(f.delivered[1], /specific persona version two/);
  persona = "";
  const failed = await f.service.review("one", session.id, session.revision, "");
  assert.equal(failed.session!.review!.status, "failed");
  assert.match(failed.session!.review!.error!, /角色上下文为空/);
  assert.equal(f.delivered.length, 2);
});

test("a mode switch or stop during persona loading cannot deliver the previous review", async t => {
  for (const action of ["set-mode", "stop"] as const) {
    let release!: (text: string) => void;
    const loading = new Promise<string>(resolve => { release = resolve; });
    const f = fixture(t, { presets: catalog, context: async () => loading });
    const session = (await f.service.start("one", start)).session!;
    f.observe();
    const pending = f.service.review("one", session.id, session.revision, "");
    await f.service.command("one", { sessionId: session.id, revision: session.revision, action, presetId: "watch" });
    release("old persona context");
    await pending;
    assert.equal(f.delivered.length, 0);
    assert.equal(f.service.snapshot("one").session!.review, null);
  }
});

test("opt-in interaction checkpoints and final summaries survive reload without observation data", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "companion-state-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const f = fixture(t, { record: session => recordCompanionInteraction(root, session), save: session => saveCompanionSummary(root, session) });
  const session = (await f.service.start("one", { ...start, saveSummary: true, voice: false })).session!;
  assert.equal((await fs.readdir(path.join(root, "companion/sessions"))).length, 1);
  assert.equal(await lastCompanionSummary(root), null);
  f.observe();
  f.advance(1000);
  const discussed = await f.service.review("one", session.id, session.revision, "A question");
  const reply = { sessionId: session.id, revision: discussed.session!.revision, reviewId: discussed.session!.review!.id, text: "A personal answer" };
  f.advance(1000);
  await f.service.reply("one", reply);
  const state = JSON.parse(await fs.readFile(path.join(root, "companion/state.json"), "utf8"));
  assert.equal(state.lastInteractionAt, 1_002_000);
  const checkpoint = JSON.parse(await fs.readFile(path.join(root, `companion/sessions/${session.id}.json`), "utf8"));
  assert.equal(checkpoint.notes.length, 2);
  assert.equal(checkpoint.subtitle, "");
  assert.equal(checkpoint.window, null);
  assert.equal(checkpoint.review, null);
  await f.service.reply("one", reply);
  await f.command("stop");
  const restored = await lastCompanionSummary(root);
  assert.equal(restored!.status, "ended");
  assert.equal(restored!.notes.length, 2);
  assert.equal(restored!.lastInteractionAt, 1_002_000);
});

test("summary opt-out performs no writes and a failed checkpoint stays visible without blocking replies", async t => {
  let writes = 0;
  const f = fixture(t, { record: async () => { writes++; throw new Error("disk unavailable"); }, save: async () => { writes++; } });
  const session = (await f.service.start("one", start)).session!;
  f.observe();
  const reviewed = await f.service.review("one", session.id, session.revision, "question");
  await f.service.reply("one", { sessionId: session.id, revision: reviewed.session!.revision, reviewId: reviewed.session!.review!.id, text: "answer" });
  await f.command("stop");
  assert.equal(writes, 0);
  const saving = await f.service.start("one", { ...start, requestId: "second-start", saveSummary: true });
  assert.match(saving.session!.error, /disk unavailable/);
});

test("queued checkpoints cannot overwrite a stopped session", async t => {
  const statuses: string[] = [];
  let release!: () => void;
  let delay = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(t, { record: async session => { if (delay) await gate; statuses.push(session.status); }, save: async session => { statuses.push(session.status); } });
  const session = (await f.service.start("one", { ...start, saveSummary: true, voice: false })).session!;
  f.observe();
  await f.service.review("one", session.id, session.revision, "");
  delay = true;
  const pending = f.service.reply("one", { sessionId: session.id, revision: session.revision, reviewId: f.service.snapshot("one").session!.review!.id, text: "answer" });
  const stopped = f.command("stop");
  release();
  await Promise.all([pending, stopped]);
  assert.equal(statuses.at(-1), "ended");
  assert.deepEqual(f.spoken, []);
});

test("a slow Agent still classifies the current window without playing an old comment", async t => {
  const f = fixture(t, { presets: [{ id: "adaptive", label: "Auto", labelEn: "Auto", reviewSeconds: 25, replyAgeSeconds: 180, reactionAgeSeconds: 30, guidance: "observe" }] });
  const s = (await f.service.start("one", start)).session!; f.observe();
  await f.service.review("one", s.id, s.revision, ""); const id = f.service.snapshot("one").session!.review!.id;
  f.advance(65_000);
  assert.equal(f.service.frameFor("one", id).length, 4);
  await f.service.reply("one", { sessionId: s.id, revision: s.revision, reviewId: id, text: "old scene comment", activityKind: "watch" });
  assert.equal(f.service.snapshot("one").session!.activityKind, "watch");
  assert.deepEqual(f.spoken, []);
  assert.match(f.delivered[0], /回传 activityKind/);
  assert.doesNotMatch(f.delivered[0], /不得|禁止|只回复此接口|不发送 QQ/);
});

test("failed dispatch backs off and a later fresh observation recovers", async t => {
  let attempts = 0;
  const f = fixture(t, { deliver: async () => { if (++attempts === 1) throw new Error("offline"); } });
  await f.service.start("one", { ...start, autoReview: true }); f.observe();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.service.snapshot("one").session!.review!.status, "failed");
  f.advance(26_000); f.observe(2); await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 1);
  f.advance(35_000); f.observe(3); await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 2);
  assert.equal(f.service.snapshot("one").session!.review!.status, "delivered");
});

test("mode changes keep the activity and discussion while fencing the old review and speech", async t => {
  const f = fixture(t, { presets: catalog }); const s = (await f.service.start("one", start)).session!; f.observe();
  await f.service.review("one", s.id, s.revision, "请帮忙看一下");
  const before = f.service.snapshot("one").session!, reviewId = before.review!.id;
  const switched = (await f.service.command("one", { sessionId: before.id, revision: before.revision, action: "set-mode", presetId: "work" })).session!;
  assert.equal(switched.id, before.id); assert.equal(switched.revision, before.revision + 1);
  assert.equal(switched.presetId, "work"); assert.equal(switched.activityKind, "work");
  assert.equal(switched.gatewayId, before.gatewayId); assert.equal(switched.observationOwner, "desktop");
  assert.equal(switched.voice, before.voice); assert.deepEqual(switched.notes, before.notes);
  assert.equal(switched.review, null); assert.equal(switched.lastObservationAt, null);
  assert.ok(f.cancelled.includes(`companion.${before.id}.${before.revision}`));
  assert.throws(() => f.service.frameFor("one", reviewId), /expired/);
  await assert.rejects(f.service.reply("one", { sessionId: before.id, revision: before.revision, reviewId, text: "old" }), /版本/);
  const snapshot = f.service.snapshot("one");
  assert.deepEqual(await f.service.command("one", { sessionId: switched.id, revision: switched.revision, action: "set-mode", presetId: "work" }), snapshot);
  await assert.rejects(f.service.command("one", { sessionId: switched.id, revision: switched.revision, action: "set-mode", presetId: "missing" }), /mode/);
  assert.deepEqual(f.service.snapshot("one"), snapshot);
});

test("explicit watch, play and work modes retain their configured scene when observations or replies disagree", async t => {
  for (const presetId of ["watch", "play", "work"] as const) {
    const f = fixture(t, { presets: catalog, sceneRules: readCompanionSceneRules({ rules: [{ kind: "other", processPattern: "player" }] }) });
    const s = (await f.service.start("one", { ...start, presetId })).session!;
    assert.equal(s.activityKind, presetId); assert.equal(f.observe().session!.activityKind, presetId);
    await f.service.review("one", s.id, s.revision, "");
    const reviewId = f.service.snapshot("one").session!.review!.id;
    await f.service.reply("one", { sessionId: s.id, revision: s.revision, reviewId, text: "", activityKind: "other" });
    assert.equal(f.service.snapshot("one").session!.activityKind, presetId);
  }
});

test("work mode observes at a lower rate and automatic replies stay silent while explicit help may speak", async t => {
  const f = fixture(t, { presets: catalog }); const s = (await f.service.start("one", { ...start, presetId: "work", autoReview: true })).session!;
  f.observe(); await new Promise(resolve => setImmediate(resolve));
  const first = f.service.snapshot("one").session!.review!.id;
  await f.service.reply("one", { sessionId: s.id, revision: s.revision, reviewId: first, text: "unsolicited comment", activityKind: "work" });
  assert.deepEqual(f.spoken, []); assert.deepEqual(f.service.snapshot("one").session!.notes, []);
  const changed = Buffer.from([0xff, 0xd8, 0x01, 0xff, 0xd9]).toString("base64");
  f.advance(59_000); f.observe(2, changed); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.delivered.length, 1);
  f.advance(1000); f.observe(3, changed); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.delivered.length, 2);
  const automatic = f.service.snapshot("one").session!.review!.id;
  await f.service.reply("one", { sessionId: s.id, revision: s.revision, reviewId: automatic, text: "", activityKind: "work" });
  await f.service.review("one", s.id, s.revision, "请解释当前错误");
  const manual = f.service.snapshot("one").session!;
  await f.service.reply("one", { sessionId: s.id, revision: manual.revision, reviewId: manual.review!.id, text: "这里缺少一个参数。", activityKind: "work" });
  assert.deepEqual(f.spoken, ["这里缺少一个参数。"]);
});

test("mode changes preserve a user pause and validate optional catalog policy fields", async t => {
  const f = fixture(t, { presets: catalog }); await f.service.start("one", start); await f.command("pause");
  const paused = f.service.snapshot("one").session!;
  const changed = (await f.service.command("one", { sessionId: paused.id, revision: paused.revision, action: "set-mode", presetId: "work" })).session!;
  assert.equal(changed.status, "paused"); assert.equal(changed.pauseReason, "user");
  const work = catalog.find(p => p.id === "work")!;
  assert.throws(() => readCompanionPresets({ presets: [{ ...work, activityKind: "invalid" }] }), /kind/);
  assert.throws(() => readCompanionPresets({ presets: [{ ...work, allowAutomaticReplies: "false" }] }), /automatic/);
});

test("ASR preparation leaves the comment response budget available", async t => {
  const f = fixture(t, { presets: [{ id: "adaptive", label: "Auto", labelEn: "Auto", reviewSeconds: 25,
    replyAgeSeconds: 180, reactionAgeSeconds: 90, guidance: "observe" }],
    transcripts: async () => { f.advance(20_000); return { events: [] }; } });
  const s = (await f.service.start("one", start)).session!; f.observe();
  await f.service.review("one", s.id, s.revision, "");
  const review = f.service.snapshot("one").session!.review!;
  assert.equal(review.reactionExpiresAt, 1_110_000);
  f.advance(65_000);
  await f.service.reply("one", { sessionId: s.id, revision: s.revision, reviewId: review.id, text: "what a twist", activityKind: "watch" });
  assert.deepEqual(f.spoken, ["what a twist"]);
  assert.equal(f.service.snapshot("one").session!.review!.outcome, "commented");
  assert.equal(f.service.snapshot("one").session!.participation!.lastCommentAt, 1_085_000);
});

test("stalled response refreshes with a new interval once comments expire", async t => {
  const f = fixture(t, { presets: [{ id: "adaptive", label: "Auto", labelEn: "Auto", reviewSeconds: 25,
    replyAgeSeconds: 180, reactionAgeSeconds: 90, silenceReviewSeconds: 90, guidance: "observe" }] });
  const s = (await f.service.start("one", { ...start, autoReview: true })).session!; f.observe();
  await new Promise(resolve => setImmediate(resolve));
  const oldReview = f.service.snapshot("one").session!.review!.id;
  f.advance(91_000); f.observe(2); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.delivered.length, 2);
  assert.notEqual(f.service.snapshot("one").session!.review!.id, oldReview);
  await assert.rejects(f.service.reply("one", { sessionId: s.id, revision: s.revision, reviewId: oldReview, text: "late" }), /过期/);
});

test("quiet replies carry participation context and static footage is reconsidered after silence", async t => {
  const f = fixture(t, { presets: [{ id: "adaptive", label: "Auto", labelEn: "Auto", reviewSeconds: 25,
    replyAgeSeconds: 180, reactionAgeSeconds: 90, silenceReviewSeconds: 90, guidance: "observe" }] });
  const s = (await f.service.start("one", { ...start, autoReview: true })).session!; f.observe();
  await new Promise(resolve => setImmediate(resolve));
  await f.service.reply("one", { sessionId: s.id, revision: s.revision,
    reviewId: f.service.snapshot("one").session!.review!.id, text: "", activityKind: "watch" });
  assert.equal(f.service.snapshot("one").session!.review!.outcome, "quiet");
  f.advance(26_000); f.observe(2); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.delivered.length, 1);
  f.advance(65_000); f.observe(3); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.delivered.length, 2);
  assert.match(f.delivered[1], /"sinceCommentSeconds":91,"quietReplies":1/);
  assert.match(f.delivered[1], /已经安静了一会儿/);
  assert.match(f.delivered[1], /桌宠气泡/);
  await f.command("pause"); f.advance(100_000); f.observe(1);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.delivered.length, 2);
});

test("expired comment is diagnosed separately from an intentional quiet reply", async t => {
  const f = fixture(t, { presets: [{ id: "adaptive", label: "Auto", labelEn: "Auto", reviewSeconds: 25,
    replyAgeSeconds: 180, reactionAgeSeconds: 90, guidance: "observe" }] });
  const s = (await f.service.start("one", start)).session!; f.observe();
  await f.service.review("one", s.id, s.revision, ""); f.advance(91_000);
  await f.service.reply("one", { sessionId: s.id, revision: s.revision,
    reviewId: f.service.snapshot("one").session!.review!.id, text: "late", activityKind: "play" });
  assert.equal(f.service.snapshot("one").session!.review!.outcome, "comment_expired");
  assert.equal(f.service.snapshot("one").session!.participation!.quietReplies, 0);
  assert.deepEqual(f.spoken, []);
});
