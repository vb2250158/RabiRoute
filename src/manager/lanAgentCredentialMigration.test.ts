import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateLanAgentSharedCredential } from "./lanAgentCredentialMigration.js";
test("legacy shared credential is retired before marker; repeated startup does not rotate again", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-migration-"));
  const registryPath = path.join(dir, "registry.json"), markerPath = path.join(dir, "marker.json");
  fs.writeFileSync(registryPath, "{}");
  let rotations = 0;
  const options = { registryPath, markerPath, rotateWebguiToken: () => { rotations++; } };
  try {
    assert.throws(() => migrateLanAgentSharedCredential({ ...options, rotateWebguiToken: () => { throw new Error("fixture-write-failure"); } }), /fixture-write-failure/);
    assert.equal(fs.existsSync(markerPath), false);
    migrateLanAgentSharedCredential(options);
    migrateLanAgentSharedCredential(options);
    assert.equal(rotations, 1);
    assert.equal(JSON.parse(fs.readFileSync(markerPath, "utf8")).legacyCredentialRotated, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
