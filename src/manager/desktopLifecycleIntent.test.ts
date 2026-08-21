import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  desktopLifecycleIntentPath,
  readDesktopLifecycleIntent,
  writeDesktopLifecycleIntent
} from "./desktopLifecycleIntent.js";

test("desktop lifecycle intent fails closed when state is missing or malformed", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-desktop-intent-"));
  try {
    assert.equal(readDesktopLifecycleIntent(rootDir), null);
    const statePath = desktopLifecycleIntentPath(rootDir);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, "not json", "utf8");
    assert.equal(readDesktopLifecycleIntent(rootDir), null);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("desktop lifecycle intent is written atomically and read back as the single desired state", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-desktop-intent-"));
  try {
    const running = writeDesktopLifecycleIntent(rootDir, "running", "windows-desktop");
    assert.equal(running.desiredState, "running");
    assert.equal(readDesktopLifecycleIntent(rootDir)?.source, "windows-desktop");

    const stopped = writeDesktopLifecycleIntent(rootDir, "stopped", "desktop-exit");
    assert.equal(stopped.desiredState, "stopped");
    assert.deepEqual(readDesktopLifecycleIntent(rootDir), stopped);

    const runtimeDir = path.dirname(desktopLifecycleIntentPath(rootDir));
    assert.deepEqual(fs.readdirSync(runtimeDir).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
