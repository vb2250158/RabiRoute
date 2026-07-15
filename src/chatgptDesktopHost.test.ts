import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  findChatGptDesktopHostExecutablesForTest,
  shouldEnsureChatGptDesktopHostVisibilityForTest
} from "./chatgptDesktopHost.js";

function createAppxPackage(root: string, packageName: string, executable: string, quote: "\"" | "'" = "\""): string {
  const packageRoot = path.join(root, packageName);
  const exePath = path.join(packageRoot, ...executable.split(/[\\/]/));
  fs.mkdirSync(path.dirname(exePath), { recursive: true });
  fs.writeFileSync(exePath, "");
  fs.writeFileSync(
    path.join(packageRoot, "AppxManifest.xml"),
    `<Package><Applications><Application EntryPoint=${quote}Windows.FullTrustApplication${quote} Executable=${quote}${executable}${quote} Id=${quote}App${quote} /></Applications></Package>`
  );
  return exePath;
}

test("ChatGPT desktop host discovery finds the configured path before manifest-declared hosts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-chatgpt-host-"));
  try {
    const configured = path.join(root, "custom", "CustomDesktopHost.exe");
    fs.mkdirSync(path.dirname(configured), { recursive: true });
    fs.writeFileSync(configured, "");
    const legacyPackage = createAppxPackage(
      root,
      "OpenAI.Codex_99.0.0.0_x64__2p2nqsd0c76g0",
      "app/Codex.exe",
      "'"
    );
    const currentPackage = createAppxPackage(
      root,
      "OpenAI.Codex_26.707.3748.0_x64__2p2nqsd0c76g0",
      "app/ChatGPT.exe"
    );
    fs.writeFileSync(path.join(path.dirname(currentPackage), "Codex.exe"), "undeclared legacy host");

    assert.deepEqual(findChatGptDesktopHostExecutablesForTest(root, configured), [
      configured,
      currentPackage,
      legacyPackage
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ChatGPT desktop host discovery reads OpenAI.ChatGPT manifests and ignores missing configured paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-chatgpt-host-"));
  try {
    const packageExe = createAppxPackage(
      root,
      "OpenAI.ChatGPT_26.707.3748.0_x64__2p2nqsd0c76g0",
      "app\\ChatGPT.exe"
    );
    assert.deepEqual(findChatGptDesktopHostExecutablesForTest(root, path.join(root, "missing", "ChatGPT.exe")), [packageExe]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ChatGPT desktop host visibility throttles repeated attempts", () => {
  assert.equal(shouldEnsureChatGptDesktopHostVisibilityForTest(20_000, 15_000, false, 10_000), false);
  assert.equal(shouldEnsureChatGptDesktopHostVisibilityForTest(26_000, 15_000, false, 10_000), true);
  assert.equal(shouldEnsureChatGptDesktopHostVisibilityForTest(20_000, 15_000, true, 10_000), true);
});
