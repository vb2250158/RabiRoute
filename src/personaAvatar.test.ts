import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readPersonaAvatar, removePersonaAvatar, savePersonaAvatar } from "./personaAvatar.js";

test("persona avatar upload preserves persona config and can be removed", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-avatar-"));
  fs.writeFileSync(path.join(roleDir, "persona.md"), "# Test", "utf8");
  fs.writeFileSync(path.join(roleDir, "personaConfig.json"), JSON.stringify({ recentMessageLimit: 8 }), "utf8");

  const saved = savePersonaAvatar(roleDir, "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  assert.equal(saved.configured, true);
  assert.match(saved.fileName || "", /^avatar-[a-f0-9]{12}\.png$/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(roleDir, "personaConfig.json"), "utf8")).recentMessageLimit, 8);
  assert.equal(JSON.parse(fs.readFileSync(path.join(roleDir, "personaConfig.json"), "utf8")).avatar, saved.fileName);

  removePersonaAvatar(roleDir);
  assert.deepEqual(readPersonaAvatar(roleDir), { configured: false });
  assert.equal(JSON.parse(fs.readFileSync(path.join(roleDir, "personaConfig.json"), "utf8")).avatar, undefined);
});

test("persona avatar ignores paths outside the role directory", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-avatar-safe-"));
  fs.writeFileSync(path.join(roleDir, "personaConfig.json"), JSON.stringify({ avatar: "../secret.png" }), "utf8");
  assert.deepEqual(readPersonaAvatar(roleDir), { configured: false });
});

test("persona avatar rejects a mismatched image payload", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-avatar-type-"));
  fs.writeFileSync(path.join(roleDir, "persona.md"), "# Test", "utf8");
  assert.throws(
    () => savePersonaAvatar(roleDir, "image/png", Buffer.from("not an image")),
    /does not match its image type/
  );
});

test("persona avatar refuses to overwrite a malformed persona config", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-avatar-config-"));
  fs.writeFileSync(path.join(roleDir, "persona.md"), "# Test", "utf8");
  fs.writeFileSync(path.join(roleDir, "personaConfig.json"), "{broken", "utf8");
  assert.throws(
    () => savePersonaAvatar(roleDir, "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    /Cannot update malformed personaConfig/
  );
  assert.equal(fs.readFileSync(path.join(roleDir, "personaConfig.json"), "utf8"), "{broken");
});

test("persona avatar replacement switches config before removing the previous managed file", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-avatar-replace-"));
  fs.writeFileSync(path.join(roleDir, "persona.md"), "# Test", "utf8");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const gif = Buffer.from("GIF89a", "ascii");
  const first = savePersonaAvatar(roleDir, "image/png", png);
  const second = savePersonaAvatar(roleDir, "image/gif", gif);
  assert.notEqual(first.fileName, second.fileName);
  assert.equal(fs.existsSync(first.filePath || ""), false);
  assert.equal(fs.existsSync(second.filePath || ""), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(roleDir, "personaConfig.json"), "utf8")).avatar, second.fileName);
});

test("persona avatar requires an existing persona", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-avatar-missing-role-"));
  assert.throws(
    () => savePersonaAvatar(roleDir, "image/gif", Buffer.from("GIF89a", "ascii")),
    /Persona does not exist/
  );
});
