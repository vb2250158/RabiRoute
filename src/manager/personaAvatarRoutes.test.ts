import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { savePersonaAvatar } from "../personaAvatar.js";
import { personaAvatarPresentation } from "./personaAvatarRoutes.js";

test("persona avatar presentation exposes a versioned URL without a filesystem path", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-avatar-presentation-"));
  fs.writeFileSync(path.join(roleDir, "persona.md"), "# Rabi", "utf8");
  savePersonaAvatar(
    roleDir,
    "image/png",
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  );

  const presentation = personaAvatarPresentation("Rabi", roleDir);
  assert.equal(presentation.avatarConfigured, true);
  assert.match(presentation.avatarUrl || "", /^\/api\/roles\/Rabi\/avatar\?v=/);
  assert.equal("avatarPath" in presentation, false);
});
