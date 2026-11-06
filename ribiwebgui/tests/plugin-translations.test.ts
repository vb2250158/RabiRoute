import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { registerPluginTranslations, type PluginTranslationCatalogs } from "../src/i18n/translationRegistry";
import { translateText } from "../src/i18n";

test("all source Web plugins register their owned copy and release it without removing host copy", async () => {
  const sourceRoot = new URL("../../src/plugins/", import.meta.url);
  const disposers: Array<() => void> = [];
  const owned: Array<{ source: string; translated: string }> = [];
  const hostSettings = translateText("设置", "en");
  let registrations = 0;
  let expectedRegistrations = 0;
  try {
    for (const directory of fs.readdirSync(sourceRoot)) {
      const packageRoot = new URL(`${directory}/`, sourceRoot);
      const packageFile = new URL("package.json", packageRoot);
      if (!fs.existsSync(packageFile)) continue;
      const pkg = JSON.parse(fs.readFileSync(packageFile, "utf8"));
      if (!pkg.rabi?.webSource) continue;
      expectedRegistrations++;
      const module = await import(new URL(pkg.rabi.webSource, packageRoot).href);
      const catalogs = (await import(new URL("web/translations.ts", packageRoot).href)).pluginTranslations as PluginTranslationCatalogs;
      const instanceApi = {
        instanceId: `test:${directory}`, pluginId: directory,
        registerPage: () => () => {}, registerSettingsRenderer: () => () => {},
        registerStatusRenderer: () => () => {}, registerTheme: () => () => {},
        registerCommand: () => () => {}, asComponent: (component: unknown) => component
      };
      disposers.push(module.activate({
        instanceIds: [instanceApi.instanceId], forInstance: () => instanceApi,
        registerTranslations: (values: PluginTranslationCatalogs) => {
          registrations++;
          return registerPluginTranslations(directory, values);
        }
      }));
      const first = Object.entries(catalogs.en || {})[0];
      if (first) {
        const [source, translated] = first;
        assert.equal(translateText(source, "en"), translated, `${directory} must load its own catalog`);
        owned.push({ source, translated });
      }
    }
    assert.equal(registrations, expectedRegistrations);
    assert.ok(owned.length > 10, "exercise actual nonempty plugin catalogs");
    assert.equal(translateText("设置", "en"), hostSettings);
  } finally {
    for (const dispose of disposers.reverse()) dispose();
  }
  for (const { source } of owned) assert.equal(translateText(source, "en"), source, "unloading removes plugin-owned copy");
  assert.equal(translateText("设置", "en"), hostSettings);
});
