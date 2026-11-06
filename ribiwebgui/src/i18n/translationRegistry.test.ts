import assert from "node:assert/strict";
import test from "node:test";
import { pluginTranslation, registerPluginTranslations, onPluginTranslationsChanged } from "./translationRegistry";
import { translateText } from "./index";

test("translation registrations retain other activations and release only their own catalogs", () => {
  let changes = 0;
  const stop = onPluginTranslationsChanged(() => { changes++; });
  const first = registerPluginTranslations("test:first", { en: { "插件生命周期测试": "Plugin lifecycle" }, ja: { "插件生命周期测试": "ライフサイクル" } });
  const second = registerPluginTranslations("test:second", { en: { "插件生命周期测试": "Plugin lifecycle" } });
  assert.equal(translateText(" 插件生命周期测试 ", "en"), " Plugin lifecycle ");
  assert.equal(translateText("插件生命周期测试", "ja"), "ライフサイクル");
  first();
  assert.equal(pluginTranslation("en", "插件生命周期测试"), "Plugin lifecycle");
  assert.equal(pluginTranslation("ja", "插件生命周期测试"), undefined);
  second();
  second();
  stop();
  assert.equal(translateText("插件生命周期测试", "en"), "插件生命周期测试");
  assert.equal(changes, 4);
});

test("a plugin registration cannot replace host shared copy or erase it on unload", () => {
  const before = translateText("设置", "en");
  assert.notEqual(before, "设置");
  const dispose = registerPluginTranslations("test:shared", { en: { "设置": "Different plugin settings" } });
  assert.equal(translateText("设置", "en"), before);
  dispose();
  assert.equal(translateText("设置", "en"), before);
});

test("conflicting plugin copy retains its active owner and restores the remaining owner after unload", () => {
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...values) => { warnings.push(values); };
  const first = registerPluginTranslations("test:first", { en: { "冲突测试": "First" } });
  const second = registerPluginTranslations("test:second", { en: { "冲突测试": "Second" } });
  try {
    assert.equal(pluginTranslation("en", "冲突测试"), "First");
    assert.equal(warnings.length, 1);
    first();
    assert.equal(pluginTranslation("en", "冲突测试"), "Second");
  } finally {
    console.warn = originalWarn;
    first();
    second();
  }
});
