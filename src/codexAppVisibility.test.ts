import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  findCodexAppExecutablesForTest,
  shouldEnsureCodexAppVisibilityForTest
} from "./codexAppVisibility.js";

function touchCodexExe(root: string, packageName: string): string {
  const exePath = path.join(root, packageName, "app", "Codex.exe");
  fs.mkdirSync(path.dirname(exePath), { recursive: true });
  fs.writeFileSync(exePath, "");
  return exePath;
}

test("Codex App visibility finds configured path before WindowsApps packages", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-codex-app-"));
  try {
    const configured = path.join(root, "custom", "Codex.exe");
    fs.mkdirSync(path.dirname(configured), { recursive: true });
    fs.writeFileSync(configured, "");
    const oldPackage = touchCodexExe(root, "OpenAI.Codex_1.0.0.0_x64__2p2nqsd0c76g0");
    const newPackage = touchCodexExe(root, "OpenAI.Codex_26.623.19656.0_x64__2p2nqsd0c76g0");

    assert.deepEqual(findCodexAppExecutablesForTest(root, configured), [
      configured,
      newPackage,
      oldPackage
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Codex App visibility ignores missing configured path and throttles repeated attempts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-codex-app-"));
  try {
    const packageExe = touchCodexExe(root, "OpenAI.Codex_26.623.19656.0_x64__2p2nqsd0c76g0");
    assert.deepEqual(findCodexAppExecutablesForTest(root, path.join(root, "missing", "Codex.exe")), [packageExe]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  assert.equal(shouldEnsureCodexAppVisibilityForTest(20_000, 15_000, false, 10_000), false);
  assert.equal(shouldEnsureCodexAppVisibilityForTest(26_000, 15_000, false, 10_000), true);
  assert.equal(shouldEnsureCodexAppVisibilityForTest(20_000, 15_000, true, 10_000), true);
});
