import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { RecentMemoryItem } from "../roleKnowledge.js";
import { CompanionActivity, recordCompanionInteraction, saveCompanionSummary } from "./companionActivity.js";
import { buildCompanionContext, COMPANION_CONTEXT_MAX_CHARS } from "./companionContext.js";

async function fixture(context: import("node:test").TestContext) {
  const roleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "companion-context-"));
  context.after(() => fs.rm(roleDirectory, { recursive: true, force: true }));
  const write = async (file: string, text: string) => {
    await fs.mkdir(path.dirname(path.join(roleDirectory, file)), { recursive: true });
    await fs.writeFile(path.join(roleDirectory, file), text);
  };
  await write("persona.md", "A precise, playful fixture persona.");
  await write("prompts/companionship.md", "Only this persona's companionship phrasing for {roleId}/{presetId}/{activityKind}.");
  const activity = new CompanionActivity({ presets: [{ id: "watch", label: "Watch", labelEn: "Watch", guidance: "Observe only", activityKind: "watch", reviewSeconds: 25, replyAgeSeconds: 30 }],
    context: session => buildCompanionContext({ roleDirectory, session, recentMemories: [] }),
    changed: () => {}, reaction: () => {}, deliver: async () => {}, speak: async () => {}, cancelSpeech: async () => {}, save: async () => {} });
  context.after(() => activity.dispose());
  const session = (await activity.start("fixture", { requestId: "fixture-start", gatewayId: "route", presetId: "watch", title: "", autoReview: false, voice: false, saveSummary: false })).session!;
  const build = (recentMemories: RecentMemoryItem[] = []) => buildCompanionContext({ roleDirectory, session, recentMemories });
  return { roleDirectory, write, session, build };
}

test("loads the persona's default prompt without config, optional skill and bounded historical context", async context => {
  const fixtureData = await fixture(context);
  await fixtureData.write("growth.md", "Previously learned relationship boundary.");
  await fixtureData.write("skills/companionship-response.md", "Use this persona's private response skill.");
  await fixtureData.write("companion/window-types.json", JSON.stringify({ video: "historical player hint" }));
  const historical = { ...fixtureData.session, id: randomUUID(), status: "ended" as const, saveSummary: true,
    lastInteractionAt: 1234, notes: [{ at: 1234, speaker: "assistant" as const, text: "A previous discussion." }] };
  await saveCompanionSummary(fixtureData.roleDirectory, historical);
  await recordCompanionInteraction(fixtureData.roleDirectory, { ...fixtureData.session, saveSummary: true, lastInteractionAt: 2345 });
  const prompt = await fixtureData.build();
  for (const value of ["precise, playful", "fixture/watch/watch", "relationship boundary", "private response skill", "historical player hint", "A previous discussion.", "2345"]) assert.ok(prompt.includes(value), value);
  assert.match(prompt, /historical, not current observation/);
  assert.match(prompt, /persisted, not a live session/);
});

test("persona configuration selects its prompt and per-preset template, without generic fallback", async context => {
  const fixtureData = await fixture(context);
  await fixtureData.write("personaConfig.json", JSON.stringify({ companion: { promptFile: "prompts/base.md", templates: { watch: "prompts/watch.md" } } }));
  await fixtureData.write("prompts/base.md", "Custom base for {roleId}");
  await fixtureData.write("prompts/watch.md", "Custom watching voice for {presetId}");
  const prompt = await fixtureData.build();
  assert.match(prompt, /Custom base for fixture/);
  assert.match(prompt, /Custom watching voice for watch/);
  assert.doesNotMatch(prompt, /Only this persona/);
  await fs.unlink(path.join(fixtureData.roleDirectory, "prompts/base.md"));
  await assert.rejects(fixtureData.build(), /Missing companion persona source/);
});

test("recent memory uses only three newest active summaries, never memory bodies or archived entries", async context => {
  const fixtureData = await fixture(context);
  const memories = Array.from({ length: 7 }, (_, index): RecentMemoryItem => ({ id: `memory-${index}`, title: `Title ${index}`,
    focus: "bounded summary ".repeat(80), content: "PRIVATE BODY MUST NOT BE INCLUDED", createdAt: "2026-01-01", updatedAt: `2026-01-0${index + 1}`, keywords: [],
    ...(index === 6 ? { consolidatedAt: "2026-02-01" } : {}) }));
  const original = structuredClone(memories);
  const prompt = await fixtureData.build(memories);
  for (const index of [3, 4, 5]) assert.ok(prompt.includes(`memory-${index}`));
  for (const index of [0, 1, 2, 6]) assert.ok(!prompt.includes(`memory-${index}`));
  assert.doesNotMatch(prompt, /PRIVATE BODY/);
  assert.deepEqual(memories, original);
  assert.ok(prompt.includes("/api/roles/fixture/memory/recent/memory-5"));
  assert.ok(prompt.length <= COMPANION_CONTEXT_MAX_CHARS);
});

test("oversized prose is truncated but oversized JSON and malformed state are rejected", async context => {
  const fixtureData = await fixture(context);
  await fixtureData.write("persona.md", "角色".repeat(50_000));
  await fixtureData.write("growth.md", "growth".repeat(50_000));
  const prompt = await fixtureData.build();
  assert.match(prompt, /truncated/);
  assert.ok(prompt.length <= COMPANION_CONTEXT_MAX_CHARS);
  await fixtureData.write("personaConfig.json", " ".repeat(65_537));
  await assert.rejects(fixtureData.build(), /bounded regular file/);
  await fixtureData.write("personaConfig.json", "{}");
  await fixtureData.write("companion/last.json", JSON.stringify({ id: "../../outside" }));
  await assert.rejects(fixtureData.build(), /Invalid companion summary pointer/);
  await fixtureData.write("companion/last.json", "not JSON");
  await assert.rejects(fixtureData.build(), /Invalid companion JSON/);
});

test("templates cannot traverse or follow a junction outside the persona directory", async context => {
  const fixtureData = await fixture(context);
  await fixtureData.write("personaConfig.json", JSON.stringify({ companion: { promptFile: "../outside.md" } }));
  await assert.rejects(fixtureData.build(), /stay inside/);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "companion-outside-"));
  context.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, "prompt.md"), "Not owned by this persona");
  const link = path.join(fixtureData.roleDirectory, "outside");
  await fs.symlink(outside, link, "junction");
  await fixtureData.write("personaConfig.json", JSON.stringify({ companion: { promptFile: "outside/prompt.md" } }));
  try { await assert.rejects(fixtureData.build(), /escapes/); }
  finally { await fs.unlink(link); }
});

test("rejects other personas' summaries and handles missing optional files", async context => {
  const fixtureData = await fixture(context);
  assert.match(await fixtureData.build(), /precise, playful/);
  await fixtureData.write("companion/state.json", JSON.stringify({ roleId: "other" }));
  await assert.rejects(fixtureData.build(), /another persona/);
  await fixtureData.write("companion/state.json", "{}");
  const summaryId = randomUUID();
  await fixtureData.write("companion/last.json", JSON.stringify({ id: summaryId }));
  await fixtureData.write(`companion/sessions/${summaryId}.json`, JSON.stringify({ roleId: "other", notes: [] }));
  await assert.rejects(fixtureData.build(), /another persona/);
});
