import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SelectionSpeechSettingsStore, selectionSpeechSettingsPath } from "./selectionSpeechSettings.js";

test("selection speech settings are host-scoped and fail closed by default", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-selection-speech-"));
  const store = new SelectionSpeechSettingsStore(selectionSpeechSettingsPath(root));

  assert.deepEqual(store.read(), { enabled: false, advanced: false, model: "" });
  assert.deepEqual(store.write({ enabled: true, advanced: true, model: " local/gpt-sovits " }), {
    enabled: true,
    advanced: true,
    model: "local/gpt-sovits"
  });
  assert.deepEqual(store.read(), { enabled: true, advanced: true, model: "local/gpt-sovits" });
});

test("selection speech settings ignore malformed persisted data", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-selection-speech-broken-"));
  const filePath = selectionSpeechSettingsPath(root);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "not json", "utf8");

  assert.deepEqual(new SelectionSpeechSettingsStore(filePath).read(), {
    enabled: false,
    advanced: false,
    model: ""
  });
});
