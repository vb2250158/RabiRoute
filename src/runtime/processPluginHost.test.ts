import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  PROCESS_PLUGIN_PROTOCOL,
  PROCESS_PLUGIN_PROTOCOL_VERSION,
  encodeProcessPluginMessage,
  parseProcessPluginMessage,
  type ProcessPluginMessage
} from "./processPluginProtocol.js";
import {
  ProcessPluginHost,
  ProcessPluginHostError,
  type ProcessPluginChild,
  type ProcessPluginSpawn
} from "./processPluginHost.js";

class FakeChild extends EventEmitter implements ProcessPluginChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  exitCode: number | null = null;
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }

  send(message: ProcessPluginMessage): void {
    this.stdout.write(encodeProcessPluginMessage(message));
  }

  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.emit("exit", code, signal);
  }
}

function manifest() {
  return {
    protocol: PROCESS_PLUGIN_PROTOCOL,
    version: PROCESS_PLUGIN_PROTOCOL_VERSION,
    type: "manifest" as const,
    manifest: {
      id: "package:manager/external-overview",
      name: "External overview",
      version: "1.0.0",
      kind: "external-process" as const,
      hosts: ["manager"] as const,
      capabilities: ["ui.contributions"] as const
    },
    contributions: [{
      kind: "status-card" as const,
      id: "external.health",
      label: { fallback: "External health" },
      hosts: ["web"] as const,
      surface: "manager",
      slot: "overview",
      queryId: "external.health",
      rendererId: "manager.health"
    }]
  };
}

function createSpawn(child: FakeChild, onMessage?: (message: ProcessPluginMessage) => void) {
  const calls: Array<{ command: string; args: readonly string[]; options: unknown }> = [];
  let buffer = "";
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index + 1);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      onMessage?.(parseProcessPluginMessage(line));
    }
  });
  const spawn: ProcessPluginSpawn = (command, args, options) => {
    calls.push({ command, args: [...args], options });
    return child;
  };
  return { spawn, calls };
}

function createHost(child: FakeChild, onMessage?: (message: ProcessPluginMessage) => void, overrides = {}) {
  const fixture = createSpawn(child, onMessage);
  const host = new ProcessPluginHost({
    instanceId: "manager:external-overview",
    expectedPluginId: "package:manager/external-overview",
    command: "node",
    args: ["plugin.js"],
    cwd: "C:\\plugins\\external-overview",
    allowedCapabilities: ["ui.contributions"],
    platform: "linux",
    spawn: fixture.spawn,
    handshakeTimeoutMs: 50,
    requestTimeoutMs: 50,
    stopTimeoutMs: 20,
    ...overrides
  });
  return { host, calls: fixture.calls };
}

async function startHost(host: ProcessPluginHost, child: FakeChild): Promise<void> {
  const started = host.start();
  child.send(manifest());
  await new Promise(resolve => setImmediate(resolve));
  child.send({
    protocol: PROCESS_PLUGIN_PROTOCOL,
    version: PROCESS_PLUGIN_PROTOCOL_VERSION,
    type: "handshake_ack",
    instanceId: "manager:external-overview"
  });
  await started;
}

test("process plugin host spawns hidden stdio process and completes the versioned handshake", async () => {
  const child = new FakeChild();
  const outbound: ProcessPluginMessage[] = [];
  const { host, calls } = createHost(child, message => outbound.push(message));

  await startHost(host, child);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.args, ["plugin.js"]);
  const spawnOptions = calls[0]?.options as {
    cwd?: string;
    shell?: boolean;
    windowsHide?: boolean;
    stdio?: string[];
  };
  assert.equal(spawnOptions.cwd, "C:\\plugins\\external-overview");
  assert.equal(spawnOptions.shell, false);
  assert.equal(spawnOptions.windowsHide, true);
  assert.deepEqual(spawnOptions.stdio, ["pipe", "pipe", "pipe"]);
  assert.deepEqual(outbound[0], {
    protocol: PROCESS_PLUGIN_PROTOCOL,
    version: PROCESS_PLUGIN_PROTOCOL_VERSION,
    type: "handshake",
    instanceId: "manager:external-overview",
    grantedCapabilities: ["ui.contributions"]
  });
  assert.deepEqual(host.snapshot().contributions, [{ ...manifest().contributions[0], label: { key: undefined, fallback: "External health" } }]);
  assert.equal(host.snapshot().state, "active");
});

test("process plugin host correlates requests and health probes", async () => {
  const child = new FakeChild();
  const { host } = createHost(child, message => {
    if (message.type === "request") {
      child.send({
        protocol: PROCESS_PLUGIN_PROTOCOL,
        version: PROCESS_PLUGIN_PROTOCOL_VERSION,
        type: "response",
        id: message.id,
        result: { echoed: message.params }
      });
    }
    if (message.type === "health") {
      child.send({
        protocol: PROCESS_PLUGIN_PROTOCOL,
        version: PROCESS_PLUGIN_PROTOCOL_VERSION,
        type: "health_result",
        id: message.id,
        status: "ok",
        detail: { queueDepth: 0 }
      });
    }
  });
  await startHost(host, child);

  assert.deepEqual(await host.request("plugin.echo", { value: 3 }), { echoed: { value: 3 } });
  assert.deepEqual(await host.health(), { status: "ok", detail: { queueDepth: 0 } });
});

test("process plugin host rejects timed out requests with a sanitized error", async () => {
  const child = new FakeChild();
  const { host } = createHost(child, undefined, { requestTimeoutMs: 5 });
  await startHost(host, child);

  await assert.rejects(
    host.request("plugin.read", { token: "super-secret", path: "C:\\private\\data.json" }),
    (error: unknown) => {
      assert.equal(error instanceof ProcessPluginHostError, true);
      assert.equal((error as ProcessPluginHostError).code, "request_timeout");
      assert.equal(String(error).includes("super-secret"), false);
      assert.equal(String(error).includes("C:\\private"), false);
      return true;
    }
  );
});

test("process plugin host fails closed on protocol errors without echoing the invalid line", async () => {
  const child = new FakeChild();
  const { host } = createHost(child);
  const started = host.start();
  child.stdout.write('{"token":"super-secret","path":"C:\\\\private\\\\plugin.js"}\n');

  await assert.rejects(started, (error: unknown) => {
    assert.equal(error instanceof ProcessPluginHostError, true);
    assert.equal((error as ProcessPluginHostError).code, "protocol_error");
    assert.equal(String(error).includes("super-secret"), false);
    assert.equal(String(error).includes("C:\\private"), false);
    return true;
  });
});

test("process plugin host sanitizes stderr when the child exits unexpectedly", async () => {
  const child = new FakeChild();
  const { host } = createHost(child);
  await startHost(host, child);
  child.stderr.write("token=super-secret C:\\private\\plugin.js\n");
  child.exit(17, null);

  await assert.rejects(host.health(), (error: unknown) => {
    assert.equal(error instanceof ProcessPluginHostError, true);
    assert.equal((error as ProcessPluginHostError).code, "unexpected_exit");
    assert.equal(String(error).includes("super-secret"), false);
    assert.equal(String(error).includes("C:\\private"), false);
    return true;
  });
  assert.equal(host.snapshot().state, "failed");
});

test("process plugin host rejects capabilities outside the configured grant", async () => {
  const child = new FakeChild();
  const { host } = createHost(child, undefined, { allowedCapabilities: [] });
  const started = host.start();
  child.send(manifest());

  await assert.rejects(started, (error: unknown) => {
    assert.equal(error instanceof ProcessPluginHostError, true);
    assert.equal((error as ProcessPluginHostError).code, "manifest_rejected");
    return true;
  });
});

test("process plugin host sends stop and uses injected Windows process-tree cleanup", async () => {
  const child = new FakeChild();
  const killed: number[] = [];
  const outbound: ProcessPluginMessage[] = [];
  const { host } = createHost(child, message => {
    outbound.push(message);
    if (message.type === "stop") {
      child.send({
        protocol: PROCESS_PLUGIN_PROTOCOL,
        version: PROCESS_PLUGIN_PROTOCOL_VERSION,
        type: "stopped"
      });
    }
  }, {
    platform: "win32",
    killTree: async (pid: number) => { killed.push(pid); }
  });
  await startHost(host, child);

  await host.stop("test complete");

  assert.equal(outbound.some(message => message.type === "stop" && message.reason === "test complete"), true);
  assert.deepEqual(killed, [4242]);
  assert.equal(host.snapshot().state, "stopped");
});

test("process plugin host cleans the Windows process tree after stop timeout", async () => {
  const child = new FakeChild();
  const killed: number[] = [];
  const { host } = createHost(child, undefined, {
    platform: "win32",
    stopTimeoutMs: 5,
    killTree: async (pid: number) => { killed.push(pid); }
  });
  await startHost(host, child);

  await assert.rejects(host.stop(), (error: unknown) => {
    assert.equal(error instanceof ProcessPluginHostError, true);
    assert.equal((error as ProcessPluginHostError).code, "stop_timeout");
    return true;
  });
  assert.deepEqual(killed, [4242]);
});
