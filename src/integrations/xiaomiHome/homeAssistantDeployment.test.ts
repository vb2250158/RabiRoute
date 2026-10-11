import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HomeAssistantDeployment, type HomeAssistantDeploymentDriver } from "./homeAssistantDeployment.js";
import type { HomeAssistantOsStatus } from "./homeAssistantOs.js";

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

test("HA OS startup and disconnect recovery coalesce, respect cooldown and preserve foreground approval", async t => {
  const f = fixture(t);
  const operations: string[] = [];
  let release: (() => void) | undefined;
  const owner = new HomeAssistantDeployment(f.root, () => "http://127.0.0.1:8123", f.io, {
    inspect: async () => ({ state: "installed", message: "installed" }),
    async run(operation) {
      operations.push(operation);
      if (operation === "Recover") await new Promise<void>(resolve => { release = resolve; });
      f.setRunning(true);
      return { state: "installed", message: "installed" };
    }
  });
  const saved = await owner.save({ mode: "haos", containerName: "homeassistant", autoStart: true }, (await owner.inspect()).revision);
  owner.start();
  const sameFailure = owner.recover();
  assert.equal(sameFailure, owner.recover());
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(operations, ["Recover"]);
  release?.();
  await sameFailure;
  assert.equal((await owner.inspect()).state, "ready");
  f.setRunning(false);
  await owner.recover();
  assert.deepEqual(operations, ["Recover"], "repeated failures are throttled");
  await owner.ensureReady(saved.revision);
  assert.deepEqual(operations, ["Recover", "Start"], "foreground start can authorize the protected helper");
  await owner.stop();
  f.setRunning(false);
  await owner.recover();
  assert.equal(operations.length, 2, "shutdown cannot restart the VM");
});

test("automatic recovery does not install, take over external services or prompt for missing approval", async t => {
  for (const mode of ["external", "haos"] as const) {
    for (const autoStart of [false, true]) {
      const f = fixture(t);
      let runs = 0;
      const owner = new HomeAssistantDeployment(f.root, () => "http://127.0.0.1:8123", f.io, {
        inspect: async () => ({ state: "not_installed", message: "absent" }),
        run: async () => { runs++; throw new Error("must not run"); }
      });
      await owner.save({ mode, containerName: "homeassistant", autoStart }, (await owner.inspect()).revision);
      owner.start();
      await owner.recover();
      await owner.stop();
      assert.equal(runs, 0);
    }
  }
  const f = fixture(t);
  const owner = new HomeAssistantDeployment(f.root, () => "http://127.0.0.1:8123", f.io, {
    inspect: async () => ({ state: "installed", message: "installed" }),
    run: async operation => { assert.equal(operation, "Recover"); throw new Error("approval absent"); }
  });
  await owner.save({ mode: "haos", containerName: "homeassistant", autoStart: true }, (await owner.inspect()).revision);
  owner.start();
  await owner.recover();
  assert.match((await owner.inspect()).message, /Windows 管理员/);
  assert.equal((await owner.inspect()).installation, "installed");
  await owner.stop();
});

test("recovery checks current configuration after an in-flight health probe", async t => {
  const f = fixture(t);
  let finish: ((ready: boolean) => void) | undefined;
  let pause = false;
  let runs = 0;
  const owner = new HomeAssistantDeployment(f.root, () => "http://127.0.0.1:8123", {
    ...f.io, ready: async () => pause ? new Promise<boolean>(resolve => { finish = resolve; }) : false
  }, {
    inspect: async () => ({ state: "installed", message: "installed" }),
    run: async () => { runs++; return { state: "installed", message: "installed" }; }
  });
  const saved = await owner.save({ mode: "haos", containerName: "homeassistant", autoStart: true }, (await f.owner.inspect()).revision);
  pause = true;
  owner.start();
  const flight = owner.recover();
  pause = false;
  await owner.save({ mode: "haos", containerName: "homeassistant", autoStart: false }, saved.revision);
  finish?.(false);
  await flight;
  assert.equal(runs, 0);
  await owner.stop();
});

test("transient recovery failure can retry after cooldown without losing installed state", async t => {
  const f = fixture(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let attempts = 0;
  const owner = new HomeAssistantDeployment(f.root, () => "http://127.0.0.1:8123", f.io, {
    inspect: async () => ({ state: "error", installed: true, message: "network not ready" }),
    run: async () => {
      attempts++;
      if (attempts === 1) throw new Error("network not ready");
      f.setRunning(true);
      return { state: "installed", message: "installed" };
    }
  });
  await owner.save({ mode: "haos", containerName: "homeassistant", autoStart: true }, (await owner.inspect()).revision);
  owner.start();
  await owner.recover();
  assert.equal(attempts, 1);
  now += 300001;
  await owner.recover();
  assert.equal(attempts, 2);
  assert.equal((await owner.inspect()).state, "ready");
  await owner.stop();
});

test("shutdown cancels its pending recovery wait without restarting or resetting the VM", async t => {
  const f = fixture(t);
  let cancelled = false;
  const owner = new HomeAssistantDeployment(f.root, () => "http://127.0.0.1:8123", f.io, {
    inspect: async () => ({ state: "installed", message: "installed" }),
    run: async (operation, _autoStart, _authority, signal) => {
      assert.equal(operation, "Recover");
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => {
        cancelled = true;
        reject(new Error("cancelled"));
      }, { once: true }));
    }
  });
  await owner.save({ mode: "haos", containerName: "homeassistant", autoStart: true }, (await owner.inspect()).revision);
  owner.start();
  await new Promise(resolve => setImmediate(resolve));
  await owner.stop();
  assert.equal(cancelled, true);
  await owner.recover();
  assert.match((await owner.inspect()).message, /取消/);
});

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

test("HA OS install preserves the preset directory and resumes after reboot without Docker", async t => {
  const f = fixture(t);
  const operations: string[] = [];
  let status: HomeAssistantOsStatus = { state: "not_installed", message: "install", root: f.root };
  const owner = new HomeAssistantDeployment(f.root, () => "http://127.0.0.1:8123", f.io, {
    installationPath: f.root,
    inspect: async () => status,
    async run(operation, autoStart) {
      operations.push(operation);
      assert.equal(autoStart, true);
      status = { ...status, state: operations.length === 1 ? "reboot_required" : "installed" };
      return status;
    }
  });
  const before = await owner.inspect();
  const saved = await owner.save({ mode: "haos", containerName: "homeassistant", autoStart: true }, before.revision);
  assert.equal(operations.length, 0, "saving must not elevate or install");
  await assert.rejects(owner.install("stale"), /部署配置已变化/);
  assert.equal((await owner.install(saved.revision)).state, "reboot_required");
  const installed = await owner.install(saved.revision);
  assert.equal(installed.installation, "installed");
  assert.equal(installed.haosInstallPath, f.root);
  assert.equal(installed.state, "starting", "VM creation is not HA readiness");
  f.setRunning(true);
  assert.equal((await owner.inspect()).state, "ready");
  assert.deepEqual(operations, ["Install", "Install"]);
  await owner.stop();
  await assert.rejects(owner.install(saved.revision), /正在停止/);
});

test("HA OS subscriptions deliver measured progress and terminal state, then release the watcher", async t => {
  const f = fixture(t);
  let changed: (() => void) | undefined;
  let unsubscribed = false;
  let status: HomeAssistantOsStatus = { state: "installing", message: "下载", progress: { phase: "download", percent: 25, completedBytes: 25, totalBytes: 100 } };
  const owner = new HomeAssistantDeployment(f.root, () => "http://127.0.0.1:8123", f.io, {
    inspect: async () => status,
    run: async () => status,
    subscribe: listener => { changed = listener; return () => { unsubscribed = true; }; }
  });
  const initial = await owner.inspect();
  await owner.save({ mode: "haos", containerName: "homeassistant", autoStart: false }, initial.revision);
  const received: Awaited<ReturnType<typeof owner.inspect>>[] = [];
  const unsubscribe = owner.subscribe(value => received.push(value));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(received[0]?.progress?.percent, 25);
  assert.equal(received[0]?.canInstall, false);
  status = { state: "reboot_required", message: "重启" };
  changed?.();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(received[1]?.state, "reboot_required");
  assert.equal(received[1]?.progress, undefined);
  unsubscribe();
  changed?.();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(received.length, 2);
  assert.equal(unsubscribed, true);
});

test("HA OS operation completion notifies other pages after clearing its active flag", async t => {
  const f = fixture(t);
  let status: HomeAssistantOsStatus = { state: "not_installed", message: "未安装" };
  const owner = new HomeAssistantDeployment(f.root, () => "http://127.0.0.1:8123", f.io, {
    inspect: async () => status,
    run: async () => { status = { state: "installed", message: "已安装" }; return status; }
  });
  const initial = await owner.inspect();
  const saved = await owner.save({ mode: "haos", containerName: "homeassistant", autoStart: false }, initial.revision);
  const snapshots: Awaited<ReturnType<typeof owner.inspect>>[] = [];
  const unsubscribe = owner.subscribe(value => snapshots.push(value));
  t.after(unsubscribe);
  await new Promise(resolve => setImmediate(resolve));
  await owner.install(saved.revision);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(snapshots.at(-1)?.state, "starting", "all subscribers must leave installing even without another file change");
  assert.equal(snapshots.at(-1)?.canInstall, true);
});
