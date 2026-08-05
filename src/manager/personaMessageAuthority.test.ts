import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadPersonaMessageAuthority } from "./personaMessageAuthority.js";

test("persona message capabilities persist across Manager restarts and stay Route-bound", (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-authority-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const first = loadPersonaMessageAuthority(rootDir);
  const rabiCapability = first.issue("rabi-main", "Rabi");
  assert.equal(first.verify("rabi-main", "Rabi", rabiCapability), true);
  assert.equal(first.verify("builder-main", "Rabi", rabiCapability), false);
  assert.equal(first.verify("rabi-main", "Builder", rabiCapability), false);

  const afterRestart = loadPersonaMessageAuthority(rootDir);
  assert.equal(afterRestart.issue("rabi-main", "Rabi"), rabiCapability);
  assert.equal(afterRestart.verify("rabi-main", "Rabi", rabiCapability), true);
});
