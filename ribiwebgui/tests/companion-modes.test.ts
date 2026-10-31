import { getTimeoutMs } from "../../src/shared/timeoutSettings";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { compileScript, parse } from "@vue/compiler-sfc";
import ts from "typescript";
import * as vue from "vue";
import { setCompanionMode } from "../src/companionActivityClient";
import type { CompanionSession, CompanionSnapshot } from "../../src/shared/companionActivity";

const presets = [
  { id: "adaptive", label: "自动陪伴", labelEn: "Automatic", reviewSeconds: 30, replyAgeSeconds: 180, guidance: "" },
  { id: "work", label: "工作陪伴", labelEn: "Work", reviewSeconds: 60, replyAgeSeconds: 180, guidance: "", activityKind: "work" },
  { id: "custom-focus", label: "自定义专注", labelEn: "Focus", reviewSeconds: 60, replyAgeSeconds: 180, guidance: "" }
] as CompanionSnapshot["presets"];
function session(overrides: Partial<CompanionSession> = {}): CompanionSession {
  return { id: "activity", roleId: "persona", gatewayId: "route", presetId: "adaptive", title: "",
    status: "active", revision: 4, startedAt: 1, lastObservationAt: null, positionSeconds: null,
    subtitle: "", autoReview: true, voice: false, saveSummary: false, notes: [{ at: 1, speaker: "user", text: "earlier discussion" }],
    review: null, error: "", observationOwner: "desktop", window: null, activityKind: "uncertain", version: 6, ...overrides };
}

function component(client: {
  companionRequest: (roleId: string, action?: string, body?: any) => Promise<CompanionSnapshot>;
  setCompanionMode: (roleId: string, current: CompanionSession, presetId: string) => Promise<CompanionSnapshot>;
}) {
  const source = fs.readFileSync(new URL("../src/components/PersonaCompanionActivity.vue", import.meta.url), "utf8");
  const { descriptor } = parse(source);
  const script = compileScript(descriptor, { id: "companion-mode-test" });
  const compiled = ts.transpileModule(script.content, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  });
  const output = { exports: {} as any };
  vm.runInNewContext(compiled.outputText, {
    module: output, exports: output.exports,
    require(name: string) {
      if (name === "../timeoutSettingsClient") return { getTimeoutMs };
      if (name === "vue") return { ...vue, onMounted() {}, onBeforeUnmount() {} };
      if (name === "../companionActivityClient") return client;
      if (name === "../managerApi") return { managerEventSource() {} };
      if (name === "../persona/personaServiceClient") return { usePersonaService: () => ({ fetch: globalThis.fetch, events() {} }) };
      if (name === "../speech/speechControlClient") return { createSpeechControlClient: () => ({}) };
      if (name === "../browserUuid") return { browserUuid: () => "start-request" };
      if (name === "../userFacingError") return { userFacingError: (error: Error) => error.message };
      throw new Error(`Unexpected component import: ${name}`);
    },
    document: { createElement: () => ({}) }, crypto: { randomUUID: () => "start-request" },
    URL, AbortSignal, clearTimeout, setTimeout, console
  });
  return output.exports.default.setup({ roleId: "persona", gatewayId: "route" }, { expose() {} });
}

test("desktop start uses the selected directory mode", async () => {
  const requests: { action?: string; body?: any }[] = [];
  const panel = component({
    async companionRequest(_roleId, action, body) {
      requests.push({ action, body });
      return { presets, session: session({ presetId: body.presetId, activityKind: "work" }) };
    }, async setCompanionMode() { throw new Error("Mode switch is not a start"); }
  });
  panel.accept({ presets, session: null });
  panel.mode.value = "work";
  await panel.shareWindow();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].action, "start");
  assert.equal(requests[0].body.presetId, "work");
  assert.equal(requests[0].body.observationOwner, "desktop");
  assert.equal(panel.session.value.presetId, "work");
  assert.equal(panel.working.value, true);
});

test("active mode switch retains activity, discussion and browser source", async () => {
  const commands: { id: string; revision: number; presetId: string }[] = [];
  const current = session({ observationOwner: "browser" });
  const panel = component({
    async companionRequest() { throw new Error("Switch must not stop or restart"); },
    async setCompanionMode(_roleId, value, presetId) {
      commands.push({ id: value.id, revision: value.revision, presetId });
      return { presets, session: { ...value, presetId, revision: value.revision + 1, version: value.version + 1, activityKind: "work" } };
    }
  });
  panel.accept({ presets, session: current });
  panel.source.value = "player";
  panel.videoUrl.value = "blob:current-video";
  panel.mode.value = "work";
  await panel.changeMode("work");
  assert.equal(commands.length, 1);
  assert.equal(commands[0].id, current.id);
  assert.equal(commands[0].revision, current.revision);
  assert.equal(commands[0].presetId, "work");
  assert.equal(panel.session.value.id, current.id);
  assert.deepEqual(panel.session.value.notes, current.notes);
  assert.equal(panel.source.value, "player");
  assert.equal(panel.videoUrl.value, "blob:current-video");
});

test("failed mode switch restores the Manager selection and reports the error", async () => {
  const current = session();
  const panel = component({
    async companionRequest() { throw new Error("Switch must not stop or restart"); },
    async setCompanionMode() { throw new Error("Mode revision changed"); }
  });
  panel.accept({ presets, session: current });
  panel.mode.value = "work";
  await panel.changeMode("work");
  assert.equal(panel.mode.value, current.presetId);
  assert.deepEqual(panel.session.value, current);
  assert.equal(panel.error.value, "Mode revision changed");
  assert.equal(panel.busy.value, false);
});

test("Manager updates synchronize selection and reject an older revision", () => {
  const panel = component({
    async companionRequest() { throw new Error("No command expected"); },
    async setCompanionMode() { throw new Error("No command expected"); }
  });
  const current = session({ presetId: "work", activityKind: "work", revision: 5 });
  panel.accept({ presets, session: current });
  panel.accept({ presets, session: session({ presetId: "adaptive", revision: 4 }) });
  assert.equal(panel.mode.value, "work");
  assert.equal(panel.session.value.revision, 5);
  panel.accept({ presets: [presets[2]], session: null });
  assert.equal(panel.mode.value, "custom-focus");
});

test("mode API sends the current activity fence and uses the returned snapshot", async () => {
  const current = session();
  const next = { presets, session: session({ presetId: "work", revision: current.revision + 1 }) };
  const original = globalThis.fetch;
  const calls: { url: string; options?: RequestInit }[] = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ code: 0, data: next }), { status: 200 });
  };
  try {
    const result = await setCompanionMode("persona/one", current, "work");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/api/roles/persona%2Fone/companion/command");
    assert.equal(calls[0].options?.method, "POST");
    assert.deepEqual(JSON.parse(String(calls[0].options?.body)), {
      sessionId: current.id, revision: current.revision, action: "set-mode", presetId: "work"
    });
    assert.deepEqual(result, next);
  } finally { globalThis.fetch = original; }
});

test("mode API exposes a rejected fence without substituting a new activity", async () => {
  const original = globalThis.fetch;
  let count = 0;
  globalThis.fetch = async () => {
    count++;
    return new Response(JSON.stringify({ code: 409, message: "Activity changed" }), { status: 409 });
  };
  try {
    await assert.rejects(setCompanionMode("persona", session(), "work"), /Activity changed/);
    assert.equal(count, 1);
  } finally { globalThis.fetch = original; }
});
