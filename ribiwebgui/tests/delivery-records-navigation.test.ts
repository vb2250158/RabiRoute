import assert from "node:assert/strict";
import test from "node:test";
import { activateDiagnostics } from "../src/bundles/builtinWebContributions";
import { buildWebNavigation } from "../src/pluginNavigation";
import { activateWebPluginForTest } from "./web-plugin-test-host";
import { translateText } from "../src/i18n";

test("delivery navigation has Chinese, English and Japanese titles", () => {
  assert.equal(translateText("投递记录", "zh-CN"), "投递记录");
  assert.equal(translateText("投递记录", "en"), "Delivery records");
  assert.equal(translateText("投递记录", "ja"), "配信記録");
});

test("the actual diagnostics plugin exposes delivery records through its owned utility navigation", async () => {
  const owner = { instanceId: "manager:diagnostics", pluginId: "io.rabiroute.manager.diagnostics" };
  const contributions: unknown[] = [];
  const { activate } = await import("../../plugins/builtin/io.rabiroute.manager.diagnostics/1.0.0/manager.mjs");
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
      ["runtime", "/routes/any-route/runtime", "mdi-console-line"],
      ["deliveries", "/deliveries", "mdi-send-check-outline"]
    ]);
    assert.equal(groups.routePrimary.length, 0);
  } finally { dispose(); }
  assert.equal(buildWebNavigation(contributions, "any-route").utility.length, 0);
});
