import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const controlPlane = new URL("./controlPlaneRoutes.ts", import.meta.url);
const plugin = new URL("../../plugins/builtin/io.rabiroute.manager.persona/1.0.0/manager.mjs", import.meta.url);

test("persona plugin keeps persona and knowledge surfaces without synchronization APIs or lifecycle", () => {
  const source = fs.readFileSync(plugin, "utf8");
  assert.doesNotMatch(source, /persona[-_]?sync/i);
  for (const contribution of ["persona-page", "knowledge-page", "persona-document-page", "open-role-directory", "open-plan-directory", "open-memory-directory"]) {
    assert.ok(source.includes(`"${contribution}"`), contribution);
  }
  assert.match(source, /handlePersonaPluginApi/);
  assert.match(source, /handleLanguageStyleApi/);
  assert.match(source, /await requestTracker\.stop\(\)/);
});

test("control plane has no synchronization owner and uses independently authorized fresh peer inventory", () => {
  const source = fs.readFileSync(controlPlane, "utf8");
  assert.doesNotMatch(source, /persona[-_]?sync/i);
  assert.match(source, /readPeerPersonaManifest\(rolesRoot, role\(input\)\)/);
  assert.match(source, /!access\(\)\.roleIds\.includes\(roleId\)/);
  assert.match(source, /peerHandler:.*activePeerRuntime\?\.handler/);
  assert.match(source, /peerUpgrade:.*activePeerTunnel\?\.upgrade/);
  assert.match(source, /activePeerTunnel\?\.startLanDiscovery/);
  assert.match(source, /peerLanServer,/);
});
