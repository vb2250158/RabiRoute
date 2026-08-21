import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { WsFrame } from "@wecom/aibot-node-sdk";
import type { WeComMessageRecord } from "../history.js";
import { createMessageAdapterRuntime } from "../runtime/messageAdapterRuntime.js";
import { builtinMessageAdapterDefinitions } from "./builtinMessageAdapters.js";
import type { WeComClientLike } from "../wecom.js";
import {
  createWeComAdapter,
  dispatchWeComRecord,
  type WeComAdapterDependencies
} from "./wecomAdapter.js";
import type { MessageAdapterDefinition, MessageAdapterDispose } from "./messageAdapter.js";

type Handler = (...args: any[]) => void;

class FakeWeComClient {
  readonly handlers = new Map<string, Handler[]>();
  connectCalls = 0;
  disconnectCalls = 0;
  connectError?: Error;
  isConnected = false;

  on(event: string, handler: Handler): this {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
    return this;
  }

  emit(event: string, ...args: any[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
  }

  connect(): void {
    this.connectCalls += 1;
    if (this.connectError) throw this.connectError;
    this.isConnected = true;
  }

  disconnect(): void {
    this.disconnectCalls += 1;
    this.isConnected = false;
  }
}

function record(patch: Partial<WeComMessageRecord> = {}): WeComMessageRecord {
  return {
    time: 1,
    rawMessage: "hello",
    messageId: "wecom-1",
    adapterType: "wecom",
    conversationId: "chat-1",
    messageType: "text",
    ...patch
  };
}

function endpoint() {
  return {
    botId: "test-bot",
    secret: "test-secret",
    wsUrl: "ws://127.0.0.1:9999"
  };
}

function readStatus(dataDir: string) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, "gateway-status.json"), "utf8"));
}

function messageFrame(): WsFrame<any> {
  return {
    headers: { req_id: "req-1" },
    body: {
      msgtype: "text",
      msgid: "message-1",
      chatid: "chat-1",
      create_time: 1,
      from: { userid: "user-1", name: "Tester" },
      text: { content: "late message" }
    }
  } as WsFrame<any>;
}

function definition(dependencies: WeComAdapterDependencies): MessageAdapterDefinition {
  return {
    manifest: {
      type: "wecom",
      label: "企业微信",
      host: "gateway",
      transport: "websocket",
      lifecycle: "fiber"
    },
    create: () => createWeComAdapter(dependencies)
  };
}

test("WeCom Fiber owns one client and ignores events after disposal", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-wecom-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const client = new FakeWeComClient();
  const adapter = createWeComAdapter({
    endpoint,
    dataDir: () => dataDir,
    memoryDataDir: () => dataDir,
    now: () => new Date("2026-08-21T00:00:00.000Z"),
    createClient: () => client as unknown as WeComClientLike
  });

  const dispose = await adapter.start() as MessageAdapterDispose;
  assert.equal(client.connectCalls, 1);
  client.emit("connected");
  client.emit("authenticated");
  assert.equal(readStatus(dataDir).messageAdapters.wecom.authenticated, true);

  await dispose();
  assert.equal(client.disconnectCalls, 1);
  const disabled = readStatus(dataDir);
  assert.equal(disabled.messageAdapters.wecom.status, "disabled");
  assert.equal(disabled.messageAdapters.wecom.connected, false);
  assert.equal(disabled.messageAdapters.wecom.authenticated, false);

  client.emit("connected");
  client.emit("authenticated");
  client.emit("message", messageFrame());
  assert.equal(readStatus(dataDir).messageAdapters.wecom.status, "disabled");
  assert.equal(readStatus(dataDir).messageAdapters.wecom.messageCount, undefined);
  assert.equal(fs.existsSync(path.join(dataDir, "wecom-messages.jsonl")), false);

  await dispose();
  assert.equal(client.disconnectCalls, 1);
});

test("WeCom Fiber creates a fresh client for each mount", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-wecom-runtime-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const clients: FakeWeComClient[] = [];
  const dependencies: WeComAdapterDependencies = {
    endpoint,
    dataDir: () => dataDir,
    memoryDataDir: () => dataDir,
    createClient: () => {
      const client = new FakeWeComClient();
      clients.push(client);
      return client as unknown as WeComClientLike;
    }
  };
  const runtime = await createMessageAdapterRuntime([definition(dependencies)]);
  t.after(() => runtime.dispose());

  const first = await runtime.mount("wecom");
  await first.dispose();
  const second = await runtime.mount("wecom");
  await second.dispose();

  assert.equal(clients.length, 2);
  assert.deepEqual(clients.map((client) => client.connectCalls), [1, 1]);
  assert.deepEqual(clients.map((client) => client.disconnectCalls), [1, 1]);
  assert.equal(readStatus(dataDir).messageAdapters.wecom.status, "disabled");
});

test("WeCom activation failure disconnects the client and records error", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-wecom-failure-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const client = new FakeWeComClient();
  client.connectError = new Error("connect failed");
  const adapter = createWeComAdapter({
    endpoint,
    dataDir: () => dataDir,
    memoryDataDir: () => dataDir,
    createClient: () => client as unknown as WeComClientLike
  });

  assert.throws(() => adapter.start(), /connect failed/);
  assert.equal(client.connectCalls, 1);
  assert.equal(client.disconnectCalls, 1);
  const status = readStatus(dataDir).messageAdapters.wecom;
  assert.equal(status.status, "error");
  assert.equal(status.connected, false);
  assert.equal(status.authenticated, false);
  assert.equal(status.lastError, "connect failed");
});

test("WeCom missing credentials does not create a client", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-wecom-missing-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let createClientCalls = 0;
  const previousConsoleError = console.error;
  console.error = () => {};
  t.after(() => { console.error = previousConsoleError; });
  const adapter = createWeComAdapter({
    endpoint: () => ({ botId: "", secret: "" }),
    dataDir: () => dataDir,
    memoryDataDir: () => dataDir,
    createClient: () => {
      createClientCalls += 1;
      return new FakeWeComClient() as unknown as WeComClientLike;
    }
  });

  const dispose = await adapter.start();
  assert.equal(typeof dispose, "function");
  assert.equal(createClientCalls, 0);
  assert.equal(readStatus(dataDir).messageAdapters.wecom.status, "error");
  await dispose?.();
});

test("WeCom records self echoes without waking the Agent", () => {
  const calls: string[] = [];
  const disposition = dispatchWeComRecord(record({ isSelf: true }), {}, {
    forward: () => calls.push("forward"),
    recordOnly: () => {
      calls.push("record");
      return 1;
    }
  });
  assert.equal(disposition, "record_only");
  assert.deepEqual(calls, ["record"]);
});

test("WeCom records unsupported inbound kinds and forwards ordinary user messages", () => {
  const calls: string[] = [];
  assert.equal(dispatchWeComRecord(record({ messageType: "video", rawMessage: "[video]" }), {}, {
    forward: () => calls.push("forward"),
    recordOnly: () => {
      calls.push("record");
      return 1;
    }
  }), "record_only");
  assert.equal(dispatchWeComRecord(record(), {}, {
    forward: () => calls.push("forward"),
    recordOnly: () => {
      calls.push("record");
      return 1;
    }
  }), "forwarded");
  assert.deepEqual(calls, ["record", "forward"]);
});

test("built-in Message Adapter manifests include WeCom", () => {
  assert.deepEqual(
    builtinMessageAdapterDefinitions().find((definition) => definition.manifest.type === "wecom")?.manifest,
    {
      type: "wecom",
      label: "企业微信",
      host: "gateway",
      transport: "websocket",
      lifecycle: "fiber"
    }
  );
});
