import { registerSourcePluginTranslations } from "./plugin-translation-test-host";
import assert from "node:assert/strict";
import test from "node:test";
import { activateDiagnostics } from "../../src/plugins/io.rabiroute.manager.diagnostics/web/contributions";
import { buildWebNavigation } from "../src/pluginNavigation";
import { activateWebPluginForTest } from "./web-plugin-test-host";
import { translateText } from "../src/i18n/index";

const disposePluginTranslations = await registerSourcePluginTranslations();
test.after(disposePluginTranslations);

test("direct delivery records page retains Chinese, English and Japanese titles", () => {
  assert.equal(translateText("投递记录", "zh-CN"), "投递记录");
  assert.equal(translateText("投递记录", "en"), "Delivery records");
  assert.equal(translateText("投递记录", "ja"), "配信記録");
});

test("the actual diagnostics plugin keeps diagnostics navigation and omits the duplicate delivery entry", async () => {
  const owner = { instanceId: "manager:diagnostics", pluginId: "io.rabiroute.manager.diagnostics" };
  const contributions: unknown[] = [];
  const { activate } = await import("../../src/plugins/io.rabiroute.manager.diagnostics/manager.mjs");
  // Register actual contributions without starting the plugin's Manager effects.
  await activate({
    identity: owner,
    services: { require: () => ({}), provide: () => {} },
    contributions: { register: (item: { kind: string; id: string; value: Record<string, unknown> }) => contributions.push({ ...item.value, kind: item.kind, id: item.id, ...owner }) },
    effects: { add: () => {} }
  });
  const dispose = activateWebPluginForTest(owner, activateDiagnostics);
  try {
    const groups = buildWebNavigation(contributions, "any-route");
    assert.deepEqual(groups.utility.map(item => [item.id, item.to, item.icon]), [
      ["runtime", "/routes/any-route/runtime", "mdi-console-line"]
    ]);
    assert.equal(groups.routePrimary.length, 0);
  } finally { dispose(); }
  assert.equal(buildWebNavigation(contributions, "any-route").utility.length, 0);
});
