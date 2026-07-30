import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";

test("safe hot reload excludes Manager and defaults to WebGUI only", () => {
  const payload = JSON.parse(execFileSync(
    process.execPath,
    ["scripts/start-hot-reload.mjs", "--describe"],
    { encoding: "utf8" }
  ));

  assert.deepEqual(payload.services, [{ name: "WebGUI", port: 8793 }]);
  assert.equal(payload.managerHotReload, false);
});

test("speech reload is explicit and Manager reload is rejected", () => {
  const payload = JSON.parse(execFileSync(
    process.execPath,
    ["scripts/start-hot-reload.mjs", "--describe", "--speech"],
    { encoding: "utf8" }
  ));
  assert.deepEqual(payload.services, [
    { name: "WebGUI", port: 8793 },
    { name: "RabiSpeech", port: 8781 }
  ]);

  const manager = spawnSync(
    process.execPath,
    ["scripts/start-hot-reload.mjs", "--manager", "--describe"],
    { encoding: "utf8" }
  );
  assert.equal(manager.status, 2);
  assert.match(manager.stderr, /does not restart Manager/);
});
