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
    advanced: true,
    model: "local/gpt-sovits"
  });
});

test("selection speech uses the default model until advanced selection is enabled", () => {
  const models = [ttsModel("tts/first"), ttsModel("tts/default", true), ttsModel("tts/offline", false, false)];
  assert.equal(resolveSelectionSpeechModel({ enabled: true, advanced: false, model: "tts/first" }, models), "tts/default");
  assert.equal(resolveSelectionSpeechModel({ enabled: true, advanced: true, model: "tts/first" }, models), "tts/first");
  assert.equal(resolveSelectionSpeechModel({ enabled: true, advanced: true, model: "tts/offline" }, models), "tts/default");
});

test("WebGUI stores system selection settings through Manager and does not inspect browser selections", () => {
  const page = fs.readFileSync(new URL("../src/pages/SpeechServicePage.vue", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("../src/App.vue", import.meta.url), "utf8");
  const client = fs.readFileSync(new URL("../src/speech/speechControlClient.ts", import.meta.url), "utf8");
  const routes = fs.readFileSync(new URL("../../src/manager/controlPlaneRoutes.ts", import.meta.url), "utf8");
  assert.match(page, /label="划词朗读"/);
  assert.match(page, /label="高级选项"[\s\S]{0,180}:disabled="!selectionSpeechEnabled/);
  assert.match(page, /v-if="selectionSpeechEnabled && selectionSpeechAdvanced"[\s\S]+label="划词朗读模型"/);
  assert.match(page, /Windows 任意支持文本选区的软件/);
  assert.match(page, /selectionReaderSettings\(\)/);
  assert.match(page, /updateSelectionReaderSettings/);
  assert.doesNotMatch(app, /selectionchange|window\.getSelection|readSelectedText|deliverSelectedText/);
  assert.match(client, /\/api\/speech\/selection-reader\/settings/);
  assert.match(routes, /GET" && requestUrl\.pathname === "\/api\/speech\/selection-reader\/settings/);
  assert.match(routes, /PUT" && requestUrl\.pathname === "\/api\/speech\/selection-reader\/settings/);
});
