import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { permitsAcceptanceOwnership } from "./managerAcceptance.js";

test("hosted acceptance requires a real isolated fixture and preserves read-only ownership", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-manager-acceptance-"));
  const fixture: NodeJS.ProcessEnv = { RABIROUTE_MANAGER_ACCEPTANCE_MODE: "1", RABIROUTE_MANAGER_READ_ONLY: "1", RABIROUTE_MANAGER_AUTOSTART: "0" };
  const hosted: NodeJS.ProcessEnv = { ...fixture, RABIROUTE_HOSTED: "1", RABIROUTE_HOST_ACCEPTANCE: "1",
    RABIROUTE_STATE_ROOT: root, RABIROUTE_MANAGER_INSTANCE_LOCK_DIR: path.join(root, "acceptance-lock"),
    RABIROUTE_MANAGER_TEST_OWNERSHIP_NAMESPACE: "RabiRoute.Host.Acceptance.0123456789ABCDEF",
    RABIROUTE_APPLICATION_GENERATION_ID: "fixture", RABIROUTE_HOST_CONTROL_TOKEN: "fixture",
    USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, PROGRAMDATA: root, TEMP: root, TMP: root,
    RABIROUTE_ACCEPTANCE_TEMP_PARENT: path.dirname(root) };
  try {
    assert.equal(permitsAcceptanceOwnership(fixture), true);
    assert.equal(permitsAcceptanceOwnership({ ...fixture, RABIROUTE_HOSTED: "1" }), false);
    assert.equal(permitsAcceptanceOwnership(hosted), false, "a marker is required before hosted acceptance");
    fs.writeFileSync(path.join(root, ".rabiroute-acceptance"), "RabiRoute isolated acceptance fixture v1");
    assert.equal(permitsAcceptanceOwnership(hosted), true);
    for (const name of ["RABIROUTE_MANAGER_ACCEPTANCE_MODE", "RABIROUTE_MANAGER_READ_ONLY", "RABIROUTE_MANAGER_AUTOSTART", "RABIROUTE_HOST_ACCEPTANCE", "RABIROUTE_HOST_CONTROL_TOKEN"]) {
      assert.equal(permitsAcceptanceOwnership({ ...hosted, [name]: "" }), false, name);
    }
    assert.equal(permitsAcceptanceOwnership({ ...hosted, LOCALAPPDATA: path.dirname(root) }), false);
    assert.equal(permitsAcceptanceOwnership({ ...hosted, RABIROUTE_ACCEPTANCE_TEMP_PARENT: root }), false);
    assert.equal(permitsAcceptanceOwnership({ ...hosted, RABIROUTE_MANAGER_INSTANCE_LOCK_DIR: path.dirname(root) }), false);
    fs.writeFileSync(path.join(root, ".env"), "fixture");
    assert.equal(permitsAcceptanceOwnership(hosted), false, "hosted acceptance refuses an env file");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
