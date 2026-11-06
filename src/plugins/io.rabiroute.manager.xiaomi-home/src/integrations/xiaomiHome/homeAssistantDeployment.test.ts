import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HomeAssistantDeployment, type HomeAssistantDeploymentDriver } from "./homeAssistantDeployment.js";
import { ManagedHaLoopbackProxy } from "./managedHaLoopbackProxy.js";
import type { HomeAssistantOsStatus } from "./homeAssistantOs.js";

const verifiedEndpoint = { address: "192.0.2.1", port: 80 as const, vmId: "a0000000-0000-0000-0000-000000000001", legacyBindingVerified: false };

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

test("recovery stops mutations after its budget but observes later positive health", async t => {
  const f = fixture(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let attempts = 0;
  let canObserve = false;
  const states: string[] = [];
  const owner = new HomeAssistantDeployment(f.root, () => "http://127.0.0.1:8123", f.io, {
    inspect: async () => ({ state: "installed", message: "installed" }),
    run: async () => { attempts++; return { state: "installed", message: "VM running, Core down", endpoint: verifiedEndpoint }; },
    observe: async () => canObserve ? verifiedEndpoint : undefined
  });
  await owner.save({ mode: "haos", containerName: "homeassistant", autoStart: true, recoveryMaxAttempts: 2 }, (await owner.inspect()).revision);
  owner.onHealthChange(state => states.push(state));
  owner.start();
  await owner.recover();
  now += 300001;
  await owner.recover();
  now += 300001;
  await owner.recover();
  assert.equal(attempts, 2);
  assert.equal((await owner.inspect()).recoveryExhausted, true);
  assert.deepEqual(states, ["unavailable", "exhausted"]);
  canObserve = true;
  f.setRunning(true);
  now += 30000;
  await owner.recover();
  assert.equal((await owner.inspect()).recoveryExhausted, false);
  assert.deepEqual(states, ["unavailable", "exhausted", "ready"]);
  await owner.stop();
});

test("an exhausted observation discards a target if deployment configuration changes in flight", async t => {
  const f = fixture(t);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const owner = new HomeAssistantDeployment(f.root, () => "http://127.0.0.1:8123", f.io, {
    inspect: async () => ({ state: "error", installed: true, message: "Core unavailable" }),
    run: async () => { throw new Error("Core unavailable"); },
    observe: async () => { entered(); await pending; return verifiedEndpoint; }
  });
  await owner.save({ mode: "haos", containerName: "homeassistant", autoStart: true, recoveryMaxAttempts: 1 }, (await owner.inspect()).revision);
  try {
    await owner.recover();
    const flight = owner.recover();
    await started;
    fs.writeFileSync(path.join(f.root, "home-assistant-deployment.json"), JSON.stringify({ schemaVersion: 1,
      config: { mode: "external", containerName: "homeassistant", autoStart: false } }));
    release();
    await flight;
    assert.equal(owner.managedIdentity(), undefined);
  } finally { release(); await owner.stop(); }
});

for (const outcome of ["unhealthy", "error", "cancelled"] as const) {
  test(`an observed endpoint is never published when its readiness check is ${outcome}`, async t => {
    const f = fixture(t);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const changes: unknown[] = [];
    const owner = new HomeAssistantDeployment(f.root, () => "http://127.0.0.1:8123", { ...f.io,
      ready: async () => {
        entered();
        if (outcome === "cancelled") { await pending; return true; }
        if (outcome === "error") throw new Error("probe failure");
        return false;
      }
    }, {
      inspect: async () => ({ state: "error", installed: true, message: "Core unavailable" }),
      run: async () => { throw new Error("Core unavailable"); },
      observe: async () => verifiedEndpoint
    });
    await owner.save({ mode: "haos", containerName: "homeassistant", autoStart: true, recoveryMaxAttempts: 1 }, (await owner.inspect()).revision);
    owner.onTargetChange(identity => changes.push(identity));
    try {
      await owner.recover();
      const flight = owner.recover();
      await started;
      const stopping = outcome === "cancelled" ? owner.stop() : undefined;
      release();
      await flight;
      await stopping;
      assert.equal(owner.managedIdentity(), undefined);
      assert.equal(Reflect.get(Reflect.get(owner, "proxy") ?? {}, "target"), undefined);
      assert.deepEqual(changes, [], "an unready target must not be exposed to credential consumers");
    } finally { release(); await owner.stop(); }
  });
}

test("a previously verified target is revoked as soon as it becomes unhealthy", async t => {
  const f = fixture(t);
  let healthy = true;
  let runs = 0;
  const changes: unknown[] = [];
  const owner = new HomeAssistantDeployment(f.root, () => "http://127.0.0.1:8123", { ...f.io, ready: async () => healthy }, {
    inspect: async () => ({ state: "installed", message: "fixture" }),
    run: async () => { if (++runs === 1) return { state: "installed", message: "ready", endpoint: verifiedEndpoint }; throw new Error("unavailable"); },
    observe: async () => undefined
  });
  await owner.save({ mode: "haos", containerName: "homeassistant", autoStart: true, recoveryMaxAttempts: 1 }, (await owner.inspect()).revision);
  owner.onTargetChange(identity => changes.push(identity));
  try {
    await owner.recover();
    assert.equal(owner.managedIdentity()?.vmId, verifiedEndpoint.vmId);
    healthy = false;
    await owner.recover();
    assert.equal(owner.managedIdentity(), undefined);
    assert.equal(Reflect.get(Reflect.get(owner, "proxy"), "target"), undefined);
    assert.equal(changes.at(-1), undefined);
  } finally { await owner.stop(); }
});

test("a normal OS start never publishes a target that fails readiness", async t => {
  const f = fixture(t);
  const changes: unknown[] = [];
  const owner = new HomeAssistantDeployment(f.root, () => "http://127.0.0.1:8123", f.io, {
    inspect: async () => ({ state: "installed", message: "fixture" }),
    run: async () => ({ state: "installed", message: "fixture", endpoint: verifiedEndpoint })
  });
  const saved = await owner.save({ mode: "haos", containerName: "homeassistant", autoStart: false }, (await owner.inspect()).revision);
  owner.onTargetChange(target => changes.push(target));
  try {
    await owner.ensureReady(saved.revision);
    assert.equal(owner.managedIdentity(), undefined);
    assert.deepEqual(changes, []);
  } finally { await owner.stop(); }
});

for (const change of ["stop", "configuration", "target"] as const) {
  test(`a pending healthy probe cannot publish ready after ${change}`, async t => {
    const f = fixture(t);
    let blocked = false;
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const health: string[] = [];
    const owner = new HomeAssistantDeployment(f.root, () => "http://127.0.0.1:8123", { ...f.io,
      ready: async () => { if (blocked) { enter(); await pending; } return true; }
    }, {
      inspect: async () => ({ state: "installed", message: "fixture" }),
      run: async () => ({ state: "installed", message: "ready", endpoint: verifiedEndpoint })
    });
    await owner.save({ mode: "haos", containerName: "homeassistant", autoStart: true }, (await owner.inspect()).revision);
    owner.onHealthChange(state => health.push(state));
    try {
      await owner.recover();
      health.length = 0;
      blocked = true;
      const flight = owner.recover();
      await entered;
      let stopping: Promise<void> | undefined;
      if (change === "stop") stopping = owner.stop();
      else if (change === "configuration") fs.writeFileSync(path.join(f.root, "home-assistant-deployment.json"), JSON.stringify({ schemaVersion: 1,
        config: { mode: "external", containerName: "homeassistant", autoStart: false } }));
      else Reflect.set(owner, "managedTarget", undefined);
      release();
      await flight;
      await stopping;
      assert.deepEqual(health, []);
    } finally { release(); await owner.stop(); }
  });
}

test("an exhausted HA OS recovery rediscovers a Core that becomes ready later without another VM restart", async t => {
  const f = fixture(t);
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  let recoveries = 0;
  let observations = 0;
  let coreReady = false;
  const owner = new HomeAssistantDeployment(f.root, () => "http://127.0.0.1:8123", f.io, {
    inspect: async () => ({ state: "error", installed: true, message: "Core unavailable" }),
    run: async () => { recoveries++; throw new Error("Core unavailable"); },
    observe: async () => { observations++; return coreReady ? verifiedEndpoint : undefined; }
  });
  await owner.save({ mode: "haos", containerName: "homeassistant", autoStart: true, recoveryMaxAttempts: 2 }, (await owner.inspect()).revision);
  try {
    await owner.recover();
    now += 300001;
    await owner.recover();
    assert.equal(recoveries, 2);
    assert.equal((await owner.inspect()).recoveryExhausted, true);
    now += 300001;
    await owner.recover();
    assert.equal(observations, 1);
    assert.equal(recoveries, 2);
    coreReady = true;
    f.setRunning(true);
    await owner.recover();
    assert.equal(observations, 1, "socket reconnects must not trigger extra observation within the interval");
    now += 30000;
    await owner.recover();
    assert.equal(observations, 2);
    assert.equal(recoveries, 2, "read-only discovery must not restart the VM");
    assert.equal(owner.managedIdentity()?.vmId, verifiedEndpoint.vmId);
    assert.equal((await owner.inspect()).recoveryExhausted, false);
  } finally { await owner.stop(); }
});

test("failed exhausted observations are coalesced and throttled from completion", async t => {
  const f = fixture(t);
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  let observations = 0;
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const owner = new HomeAssistantDeployment(f.root, () => "http://127.0.0.1:8123", f.io, {
    inspect: async () => ({ state: "error", installed: true, message: "Core unavailable" }),
    run: async () => { throw new Error("Core unavailable"); },
    observe: async () => { observations++; entered(); await pending; throw new Error("observation unavailable"); }
  });
  await owner.save({ mode: "haos", containerName: "homeassistant", autoStart: true, recoveryMaxAttempts: 1,
    healthCheckIntervalMs: 30000 }, (await owner.inspect()).revision);
  try {
    await owner.recover();
    const flight = owner.recover();
    await started;
    assert.equal(owner.recover(), flight, "concurrent triggers must share the running observation");
    now += 30001;
    release();
    await flight;
    await owner.recover();
    assert.equal(observations, 1);
    now += 30000;
    await owner.recover();
    assert.equal(observations, 2);
  } finally { release(); await owner.stop(); }
});

test("failed recovery waits a full cooldown after the operation finishes", async t => {
  const f = fixture(t);
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  let attempts = 0;
  let release: (() => void) | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const owner = new HomeAssistantDeployment(f.root, () => "http://127.0.0.1:8123", f.io, {
    inspect: async () => ({ state: "installed", message: "installed" }),
    run: async () => {
      attempts++;
      if (attempts === 1) await new Promise<void>(resolve => { release = resolve; markStarted?.(); });
      throw new Error("Core unavailable");
    }
  });
  await owner.save({ mode: "haos", containerName: "homeassistant", autoStart: true, recoveryCooldownMs: 300000 }, (await owner.inspect()).revision);
  try {
    owner.start();
    const first = owner.recover();
    await started;
    assert.equal(attempts, 1);
    now += 300001;
    assert.equal(owner.recover(), first, "concurrent calls join the running attempt");
    release?.();
    await first;
    await owner.recover();
    assert.equal(attempts, 1, "a slow failed operation must not consume its cooldown while running");
    now += 299999;
    await owner.recover();
    assert.equal(attempts, 1, "recovery remains throttled until the full cooldown expires");
    now += 1;
    await owner.recover();
    assert.equal(attempts, 2, "recovery can retry once the cooldown has elapsed");
  } finally {
    release?.();
    await owner.stop();
  }
});

test("HA OS startup and disconnect recovery coalesce, respect cooldown and preserve foreground approval", async t => {
  const f = fixture(t);
  const operations: string[] = [];
  let release: (() => void) | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const owner = new HomeAssistantDeployment(f.root, () => "http://127.0.0.1:8123", f.io, {
    inspect: async () => ({ state: "installed", message: "installed" }),
    async run(operation) {
      operations.push(operation);
      if (operation === "Recover") await new Promise<void>(resolve => { release = resolve; markStarted?.(); });
      f.setRunning(true);
      return { state: "installed", message: "installed", endpoint: verifiedEndpoint };
    }
  });
  const saved = await owner.save({ mode: "haos", containerName: "homeassistant", autoStart: true }, (await owner.inspect()).revision);
  owner.start();
  const sameFailure = owner.recover();
  assert.equal(sameFailure, owner.recover());
  await started;
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
  assert.match((await owner.inspect()).message, /Rabi Host 的管理员权限/);
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
    run: async () => { runs++; return { state: "installed", message: "installed", endpoint: verifiedEndpoint }; }
  });
  const saved = await owner.save({ mode: "haos", containerName: "homeassistant", autoStart: true }, (await f.owner.inspect()).revision);
  await owner.ensureReady(saved.revision);
  runs = 0;
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
      return { state: "installed", message: "installed", endpoint: verifiedEndpoint };
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
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const owner = new HomeAssistantDeployment(f.root, () => "http://127.0.0.1:8123", f.io, {
    inspect: async () => ({ state: "installed", message: "installed" }),
    run: async (operation, _autoStart, _authority, signal) => {
      assert.equal(operation, "Recover");
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          cancelled = true;
          reject(new Error("cancelled"));
        }, { once: true });
        markStarted?.();
      });
    }
  });
  await owner.save({ mode: "haos", containerName: "homeassistant", autoStart: true }, (await owner.inspect()).revision);
  owner.start();
  await started;
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
      return { ...status, endpoint: status.state === "installed" ? verifiedEndpoint : undefined };
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
  await owner.ensureReady(saved.revision);
  assert.equal((await owner.inspect()).state, "ready");
  assert.deepEqual(operations, ["Install", "Install", "Start"]);
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
  t.after(() => owner.stop());
  await new Promise(resolve => setImmediate(resolve));
  await owner.install(saved.revision);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(snapshots.at(-1)?.state, "starting", "all subscribers must leave installing even without another file change");
  assert.equal(snapshots.at(-1)?.canInstall, true);
});


test("deployment unsubscribe joins its original pending observation and emits no late snapshot", async t => {
  const f = fixture(t); let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  let released = false;
  const owner = new HomeAssistantDeployment(f.root, () => "http://127.0.0.1:8123", f.io, {
    inspect: async () => { entered(); await gate; return { state: "not_installed", message: "fixture" }; },
    run: async () => { throw new Error("No real installation is permitted."); },
    subscribe: () => () => { released = true; }
  });
  const snapshots: unknown[] = [];
  const unsubscribe = owner.subscribe(value => snapshots.push(value));
  try {
    await started; let completed = false; const closing = unsubscribe().then(() => { completed = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(released, true); assert.equal(completed, false);
    release(); await closing; assert.deepEqual(snapshots, []);
  } finally { release(); await unsubscribe(); await owner.stop(); }
});


test("managed transport is dynamic, rejects unverified status endpoints, and closes on stop", async t => {
  const f = fixture(t);
  const probes: string[] = [];
  let endpoint: typeof verifiedEndpoint | undefined;
  const owner = new HomeAssistantDeployment(f.root, () => "http://127.0.0.1:8123", {
    ...f.io, ready: async url => { probes.push(url); return true; }
  }, {
    inspect: async () => ({ state: "installed", message: "installed", endpoint: verifiedEndpoint }),
    run: async () => ({ state: "installed", message: "installed", endpoint })
  });
  const saved = await owner.save({ mode: "haos", containerName: "homeassistant", autoStart: false }, (await owner.inspect()).revision);
  const identities: Array<ReturnType<typeof owner.managedIdentity>> = [];
  const unsubscribe = owner.onTargetChange(identity => identities.push(identity));
  assert.equal(owner.managedBaseUrl(), undefined);
  assert.equal(owner.managedIdentity(), undefined);
  assert.equal((await owner.inspect()).state, "starting");
  assert.deepEqual(probes, [], "status endpoint must not trigger readiness or claim a target");
  const [url, same] = await Promise.all([owner.prepareTransport(), owner.prepareTransport()]);
  assert.equal(url, same);
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.notEqual(url, "http://127.0.0.1:8123");
  await owner.ensureReady(saved.revision);
  assert.deepEqual(probes, [], "driver without a receipt must fail closed");
  endpoint = verifiedEndpoint;
  assert.equal((await owner.ensureReady(saved.revision)).state, "ready");
  assert.ok(probes.join(",").includes(`http://${verifiedEndpoint.address}:${verifiedEndpoint.port}`));
  assert.ok(probes.join(",").includes(url));
  assert.deepEqual(owner.managedIdentity(), verifiedEndpoint);
  await owner.stop();
  assert.deepEqual(identities, [verifiedEndpoint, undefined]);
  unsubscribe();
  assert.equal(owner.managedBaseUrl(), undefined);
  await assert.rejects(owner.prepareTransport());
});

test("deployment configuration changes are observable and invalidate the managed target", async t => {
  const f = fixture(t);
  const owner = new HomeAssistantDeployment(f.root, () => "http://127.0.0.1:8123", f.io, {
    inspect: async () => ({ state: "installed", message: "installed" }),
    run: async () => ({ state: "installed", message: "installed", endpoint: verifiedEndpoint })
  });
  const modes: string[] = [];
  const unsubscribe = owner.onConfigChange(config => modes.push(config.mode));
  const saved = await owner.save({ mode: "haos", containerName: "homeassistant", autoStart: false }, (await owner.inspect()).revision);
  assert.equal(owner.managedMode(), true);
  await owner.ensureReady(saved.revision);
  await owner.save({ mode: "external", containerName: "homeassistant", autoStart: false }, saved.revision);
  assert.equal(owner.managedMode(), false);
  assert.deepEqual(modes, ["haos", "external"]);
  unsubscribe();
  await owner.stop();
});


test("an OS receipt is discarded if configuration changes while it runs", async t => {
  const f = fixture(t);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const owner = new HomeAssistantDeployment(f.root, () => "http://127.0.0.1:8123", f.io, {
    inspect: async () => ({ state: "installed", message: "installed" }),
    run: async () => { entered(); await gate; return { state: "installed", message: "installed", endpoint: verifiedEndpoint }; }
  });
  const saved = await owner.save({ mode: "haos", containerName: "homeassistant", autoStart: false }, (await owner.inspect()).revision);
  const notifications: unknown[] = [];
  owner.onTargetChange(value => notifications.push(value));
  const operation = owner.ensureReady(saved.revision);
  try {
    await started;
    fs.writeFileSync(path.join(f.root, "home-assistant-deployment.json"), JSON.stringify({ schemaVersion: 1, config: { ...saved.config, autoStart: true } }));
    release();
    await operation;
    assert.equal(owner.managedIdentity(), undefined);
    assert.deepEqual(notifications, []);
  } finally { release(); await owner.stop(); }
});


test("a different verified VM is never installed as the proxy target", async t => {
  const f = fixture(t);
  f.setRunning(true);
  let receipt = verifiedEndpoint;
  const realSetTarget = ManagedHaLoopbackProxy.prototype.setTarget;
  const seen: Array<Parameters<typeof realSetTarget>[0]> = [];
  t.mock.method(ManagedHaLoopbackProxy.prototype, "setTarget", function (this: ManagedHaLoopbackProxy, target: Parameters<typeof realSetTarget>[0]) {
    seen.push(target);
    return realSetTarget.call(this, target);
  });
  const owner = new HomeAssistantDeployment(f.root, () => "http://127.0.0.1:8123", f.io, {
    inspect: async () => ({ state: "installed", message: "installed" }),
    run: async () => ({ state: "installed", message: "installed", endpoint: receipt })
  });
  const saved = await owner.save({ mode: "haos", containerName: "homeassistant", autoStart: false }, (await owner.inspect()).revision);
  try {
    await owner.ensureReady(saved.revision);
    assert.deepEqual(owner.managedIdentity(), verifiedEndpoint);
    receipt = { ...verifiedEndpoint, address: "192.0.2.2", vmId: "b0000000-0000-0000-0000-000000000002" };
    await owner.ensureReady(saved.revision);
    assert.equal(owner.managedIdentity(), undefined);
    assert.deepEqual(seen.filter(Boolean), [verifiedEndpoint], "the replacement address must never reach setTarget");
    receipt = { ...verifiedEndpoint, address: "192.0.2.3", vmId: verifiedEndpoint.vmId.toUpperCase() };
    await owner.ensureReady(saved.revision);
    assert.deepEqual(owner.managedIdentity(), receipt, "same VM may change address");
  } finally { await owner.stop(); }
});
