import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HomeAssistantDeployment, type HomeAssistantDeploymentDriver } from "./homeAssistantDeployment.js";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ha-deployment-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let running = false;
  let exists = true;
  let available = true;
  let image = "ghcr.io/home-assistant/home-assistant:2026.9.2";
  const calls: string[][] = [];
  const io: HomeAssistantDeploymentDriver = {
    async run(args) {
      calls.push(args);
      if (!available) throw new Error("engine unavailable");
      if (args[0] === "info") return "/var/lib/docker";
      if (args[1] === "ls") return exists ? "container-id" : "";
      if (args[1] === "start") { running = true; return "container-id"; }
      return JSON.stringify([{ Id: "container-id", Config: { Image: image }, State: { Running: running },
        Mounts: [{ Type: "bind", Source: "/local/ha", Destination: "/config" }],
        NetworkSettings: { Ports: { "8123/tcp": [{ HostIp: "127.0.0.1", HostPort: "8123" }] } } }]);
    },
    async ready() { return running; }
  };
  const owner = new HomeAssistantDeployment(root, () => "http://127.0.0.1:8123", io);
  return { root, io, owner, calls, setExists: (value: boolean) => { exists = value; },
    setRunning: (value: boolean) => { running = value; },
    setAvailable: (value: boolean) => { available = value; }, setImage: (value: string) => { image = value; } };
}

test("deployment detection distinguishes unavailable engine, absent container and installed path", async t => {
  const f = fixture(t);
  const original = await f.owner.inspect();
  assert.equal(original.configured, false);
  const configured = await f.owner.save({ mode: "docker", containerName: "homeassistant", autoStart: false }, original.revision);
  assert.equal(configured.installation, "installed");
  assert.equal(configured.configured, true);
  assert.equal(configured.configPath, "/local/ha");
  assert.equal(configured.installationPath, "/var/lib/docker");
  assert.equal(configured.state, "stopped");
  f.setExists(false);
  assert.equal((await f.owner.inspect()).installation, "not_found");
  f.setAvailable(false);
  assert.equal((await f.owner.inspect()).installation, "unknown");
  assert.equal(f.calls.some(args => args[1] === "start"), false);
});

test("saved autostart survives recreation and concurrent starts reuse the verified container", async t => {
  const f = fixture(t);
  const initial = await f.owner.inspect();
  const saved = await f.owner.save({ mode: "docker", containerName: "homeassistant", autoStart: true }, initial.revision);
  assert.equal(saved.state, "ready");
  await Promise.all([f.owner.ensureReady(saved.revision), f.owner.ensureReady(saved.revision)]);
  assert.equal(f.calls.filter(args => args[1] === "start").length, 1);
  f.setRunning(false);
  const restarted = new HomeAssistantDeployment(f.root, () => "http://127.0.0.1:8123", f.io);
  restarted.start();
  await new Promise(resolve => setImmediate(resolve));
  await restarted.stop();
  assert.equal((await restarted.inspect()).config.autoStart, true);
  assert.deepEqual(f.calls.filter(args => args[1] === "start"), [["container", "start", "container-id"], ["container", "start", "container-id"]]);
});

test("stale revision, foreign images, mismatched addresses and stopped owners cannot launch", async t => {
  const f = fixture(t);
  const original = await f.owner.inspect();
  const saved = await f.owner.save({ mode: "docker", containerName: "homeassistant", autoStart: false }, original.revision);
  await assert.rejects(f.owner.ensureReady("stale-revision"), /部署配置已变化/);
  f.setImage("unrelated/service:latest");
  assert.equal((await f.owner.inspect()).canStart, false);
  await assert.rejects(f.owner.ensureReady(saved.revision), /不是 Home Assistant/);
  f.setImage("ghcr.io/home-assistant/home-assistant:2026.9.2");
  const wrongAddress = new HomeAssistantDeployment(f.root, () => "http://192.168.1.2:8123", f.io);
  assert.equal((await wrongAddress.inspect()).canStart, false);
  await f.owner.stop();
  await assert.rejects(f.owner.ensureReady(saved.revision), /正在停止/);
  assert.equal(f.calls.some(args => args[1] === "start"), false);
});
