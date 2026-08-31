import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const gatewayStoreSource = fs.readFileSync(new URL("../src/stores/gatewayStore.ts", import.meta.url), "utf8");
const routeConfigSource = fs.readFileSync(new URL("../src/pages/RouteConfigPage.vue", import.meta.url), "utf8");
const settingsSource = fs.readFileSync(new URL("../src/pages/SettingsPage.vue", import.meta.url), "utf8");
const catalogSource = fs.readFileSync(new URL("../src/i18n/catalog.ts", import.meta.url), "utf8");
const sharedGatewayModelSource = fs.readFileSync(new URL("../../src/shared/gatewayConfigModel.ts", import.meta.url), "utf8");
const functionMapSource = fs.readFileSync(new URL("../../docs/project-function-map.md", import.meta.url), "utf8");
const functionMapEnglishSource = fs.readFileSync(new URL("../../docs/project-function-map_en.md", import.meta.url), "utf8");
const projectDocsPageSource = fs.readFileSync(new URL("../src/pages/ProjectDocsPage.vue", import.meta.url), "utf8");
const speechBenchmarkReportSource = fs.readFileSync(new URL("../public/reports/rabispeech-model-benchmark.html", import.meta.url), "utf8");

test("WebGUI does not invent a fixed Manager endpoint before Host READY", () => {
  assert.match(gatewayStoreSource, /managerPort:\s*0,/);
  assert.match(settingsSource, /managerPort:\s*0,/);
  assert.doesNotMatch(gatewayStoreSource, /managerPort:\s*8790/);
  assert.doesNotMatch(settingsSource, /managerPort:\s*8790/);
  assert.doesNotMatch(routeConfigSource, /store\.meta\.managerPort\s*\|\|\s*8790/);
  assert.doesNotMatch(sharedGatewayModelSource, /managerPort\s*=\s*8790/);
});

test("firewall guidance follows the current Host READY endpoint", () => {
  assert.match(settingsSource, /Host READY 当前发布的动态 Manager 地址/);
  assert.match(catalogSource, /dynamic Manager endpoint published by the current Host READY state/);
  assert.doesNotMatch(settingsSource, /RabiRoute\/Node\.js[^\n]*8790/);
  assert.doesNotMatch(catalogSource, /RabiRoute\/Node\.js[^\n]*8790/);
});

test("current function maps expose only the Host-owned Windows lifecycle", () => {
  for (const source of [functionMapSource, functionMapEnglishSource]) {
    assert.match(source, /RabiRouteHost\.exe --command status --json/);
    assert.match(source, /Host READY Manager URL/);
    assert.doesNotMatch(source, /RabiRoute-Desktop\.exe/);
    assert.doesNotMatch(source, /build-desktop-exe\.ps1/);
  }
});

test("packaged documentation surfaces keep the current Host generation contract", () => {
  assert.match(speechBenchmarkReportSource, /Host READY 发布的动态 Manager URL 与本代身份/);
  assert.match(speechBenchmarkReportSource, /applicationGenerationId 与 managerInstanceId/);
  for (const source of [projectDocsPageSource, speechBenchmarkReportSource]) {
    assert.doesNotMatch(source, /Manager 8790/);
    assert.doesNotMatch(source, /RabiRoute-Desktop\.exe/);
    assert.doesNotMatch(source, /build-desktop-exe\.ps1/);
  }
});
