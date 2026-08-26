import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import type { SpeechModel } from "../../src/shared/speechControlContract";
import {
  normalizeSelectionSpeechSettings,
  resolveSelectionSpeechModel
} from "../../src/shared/selectionSpeechContract";

function ttsModel(id: string, isDefault = false, available = true): SpeechModel {
  return {
    id,
    capability: "tts",
    provider: "fixture",
    model: id,
    name: id,
    family: "fixture",
    installed: true,
    enabled: true,
    loaded: false,
    available,
    isDefault,
    languages: ["zh"],
    features: []
  };
}

test("selection speech settings normalize the host preference payload", () => {
  assert.deepEqual(normalizeSelectionSpeechSettings({ enabled: true, advanced: true, model: " local/gpt-sovits " }), {
    enabled: true,
    readAloudEnabled: true,
    advanced: true,
    model: "local/gpt-sovits"
  });
  assert.deepEqual(normalizeSelectionSpeechSettings({ enabled: true, readAloudEnabled: false }), {
    enabled: true,
    readAloudEnabled: false,
    advanced: false,
    model: ""
  });
});

test("selection speech uses the default model until advanced selection is enabled", () => {
  const models = [ttsModel("tts/first"), ttsModel("tts/default", true), ttsModel("tts/offline", false, false)];
  assert.equal(resolveSelectionSpeechModel({ enabled: true, readAloudEnabled: true, advanced: false, model: "tts/first" }, models), "tts/default");
  assert.equal(resolveSelectionSpeechModel({ enabled: true, readAloudEnabled: true, advanced: true, model: "tts/first" }, models), "tts/first");
  assert.equal(resolveSelectionSpeechModel({ enabled: true, readAloudEnabled: true, advanced: true, model: "tts/offline" }, models), "tts/default");
});

test("WebGUI stores trusted system selection settings through Manager and does not inspect browser selections", () => {
  const page = fs.readFileSync(new URL("../src/pages/SettingsPage.vue", import.meta.url), "utf8");
  const renderer = fs.readFileSync(new URL("../src/components/renderers/DesktopSettingsRenderer.vue", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("../src/App.vue", import.meta.url), "utf8");
  const client = fs.readFileSync(new URL("../src/speech/speechControlClient.ts", import.meta.url), "utf8");
  const routes = fs.readFileSync(new URL("../../src/manager/controlPlaneRoutes.ts", import.meta.url), "utf8");
  assert.match(page, /TrustedWebRendererHost/);
  assert.doesNotMatch(page, /selectionSpeechEnabled|selectionSpeechAdvanced|selectionSpeechModel/);
  assert.match(renderer, /开启滑词菜单/);
  assert.match(renderer, /label="开启滑词菜单"/);
  assert.match(renderer, /small-title">滑词朗读/);
  assert.match(renderer, /label="滑词朗读"/);
  assert.match(renderer, /label="高级选项"[\s\S]{0,280}:disabled="[^"]*selectionReadAloudEnabled/);
  assert.match(renderer, /v-if="selectionReadAloudEnabled && selectionSpeechAdvanced"[\s\S]+label="滑词朗读模型"/);
  assert.match(renderer, /selectionReaderSettings\(\)/);
  assert.match(renderer, /updateSelectionReaderSettings/);
  assert.doesNotMatch(app, /selectionchange|window\.getSelection|readSelectedText|deliverSelectedText/);
  assert.match(client, /\/api\/speech\/selection-reader\/settings/);
  assert.match(routes, /GET" && requestUrl\.pathname === "\/api\/speech\/selection-reader\/settings/);
  assert.match(routes, /PUT" && requestUrl\.pathname === "\/api\/speech\/selection-reader\/settings/);
});
