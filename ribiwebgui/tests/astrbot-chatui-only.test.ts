import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const routeConfigSource = fs.readFileSync(new URL("../src/pages/RouteConfigPage.vue", import.meta.url), "utf8");
const quickSetupSource = fs.readFileSync(new URL("../src/components/QuickSetupDialog.vue", import.meta.url), "utf8");

test("AstrBot WebGUI uses only the ChatUI send path", () => {
  assert.doesNotMatch(routeConfigSource, /deployAstrbotAdapter/);
  assert.doesNotMatch(routeConfigSource, /deploy-astrbot-adapter/);
  assert.doesNotMatch(routeConfigSource, /deployingAstrbot|astrbotDeployResult/);
  assert.doesNotMatch(routeConfigSource, /rabiroute_agent|旧插件默认管线/);
  assert.match(routeConfigSource, /\/api\/chat\/send/);
  assert.match(quickSetupSource, /\/api\/chat\/send/);
});
