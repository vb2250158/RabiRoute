import assert from "node:assert/strict";
import test from "node:test";
import {
  codexModelPickerItems,
  dshModelPickerItems,
  dshModelValue,
  parseDshModelValue,
  reasoningEffortPickerItems
} from "../src/agentModelPicker";

const models = [{
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  isDefault: true,
  reasoningEfforts: [{ id: "none" }, { id: "high" }]
}, {
  provider: "deepseek-official",
  providerName: "DeepSeek",
  id: "deepseek-v4-pro",
  name: "DeepSeek V4 Pro",
  reasoningEfforts: [{ id: "high" }, { id: "max" }]
}];

test("Codex model picker uses model ids while keeping human-readable titles", () => {
  assert.deepEqual(codexModelPickerItems(models), [{
    title: "GPT-5.6 Luna · gpt-5.6-luna",
    value: "gpt-5.6-luna"
  }, {
    title: "DeepSeek V4 Pro · deepseek-v4-pro",
    value: "deepseek-v4-pro"
  }]);
  assert.deepEqual(reasoningEffortPickerItems(models, "gpt-5.6-luna"), ["none", "high"]);
});

test("DSH model picker preserves provider and accepts manual provider/model input", () => {
  assert.deepEqual(dshModelPickerItems(models), [{
    title: "DeepSeek · DeepSeek V4 Pro",
    value: "deepseek-official/deepseek-v4-pro"
  }]);
  assert.equal(dshModelValue("deepseek-official", "deepseek-v4-pro"), "deepseek-official/deepseek-v4-pro");
  assert.deepEqual(parseDshModelValue("deepseek-official/custom/model", models), {
    provider: "deepseek-official",
    model: "custom/model"
  });
  assert.deepEqual(parseDshModelValue("deepseek-v4-pro", models), {
    provider: "deepseek-official",
    model: "deepseek-v4-pro"
  });
  assert.deepEqual(reasoningEffortPickerItems(models, "deepseek-v4-pro", "deepseek-official"), ["high", "max"]);
});
