import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import net from "node:net";
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

test("WebGUI preflight allows its preferred port to be occupied", async t => {
  const server = net.createServer();
  let ownsPort = false;
  try {
    await new Promise((resolve, reject) => server.once("error", reject).listen(8793, "127.0.0.1", resolve));
    ownsPort = true;
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw error;
  }
  if (ownsPort) t.after(() => new Promise(resolve => server.close(resolve)));
  const child = spawnSync(process.execPath, ["scripts/start-hot-reload.mjs", "--check"], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /services report their listening addresses/);
});
