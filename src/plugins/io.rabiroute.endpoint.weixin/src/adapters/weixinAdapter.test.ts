import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendWeixinMessageToDir } from "../../../../history.js";
import type { WeixinMessageRecord } from "../../../../history.js";
import { createMessageAdapterRuntime } from "../../../../runtime/messageAdapterRuntime.js";
import { readWeixinState, writeWeixinState, type WeixinOpenClawState } from "../weixinOpenClaw.js";
import type { MessageAdapterDefinition, MessageAdapterDispose } from "../../../../adapters/messageAdapter.js";
import { RabiCordisHost } from "../../../../runtime/cordisHost.js";
import { createMessageEndpointHostPorts } from "../../../../runtime/messageEndpointHostPorts.js";
import { mountGatewayEndpointPlugins } from "../../../../runtime/gatewayEndpointPlugins.js";
import { PluginProfileSettings } from "../../../../plugin-runtime-host/profileSettings.js";
import type { GatewayDefinition } from "../../../../shared/gatewayConfigModel.js";
import {
  createWeixinAdapter,
  dispatchWeixinRecord,
  type WeixinAdapterDependencies
} from "./weixinAdapter.js";

function record(patch: Partial<WeixinMessageRecord> = {}): WeixinMessageRecord {
  return {
    time: 1,
    rawMessage: "hello",
    messageId: "weixin-1",
    adapterType: "weixin",
    sessionId: "session-1",
    userId: "user-1",
    senderName: "User",
    messageType: "text",
    ...patch
  };
}

test("personal Weixin forwards text and downloaded images, but records unreadable media", async () => {
  const calls: string[] = [];
  const handlers = {
    forward: () => calls.push("forward"),
    recordOnly: async () => {
      calls.push("record");
      return 1;
    }
  };

  assert.equal(await dispatchWeixinRecord(record(), {}, handlers), "forwarded");
  assert.equal(await dispatchWeixinRecord(record({ messageType: "image", rawMessage: "[图片]" }), {}, handlers), "record_only");
  assert.equal(await dispatchWeixinRecord(record({
    messageType: "image",
    rawMessage: "[图片附件：C:\\private\\image-0.png]",
    attachments: [{ path: "C:\\private\\image-0.png", name: "image-0.png", mimeType: "image/png", size: 42 }]
  }), {}, handlers), "forwarded");
  assert.deepEqual(calls, ["forward", "record", "forward"]);
});


function recoverableState(): WeixinOpenClawState {
  return {
    token: "runtime-token",
    baseUrl: "https://api.example.invalid",
    contextTokens: {},
    authState: "recoverable",
    credentialsRetained: true,
    updatedAt: "2026-08-21T00:00:00.000Z"
  };
}

function readStatus(dataDir: string) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, "gateway-status.json"), "utf8"));
}

function definition(dependencies: WeixinAdapterDependencies): MessageAdapterDefinition {
  return {
    manifest: {
      type: "weixin",
      label: "个人微信",
      host: "gateway",
      transport: "http",
      lifecycle: "fiber"
    },
    create: () => createWeixinAdapter(dependencies)
  };
}

test("Weixin Fiber aborts its active long poll and records disabled", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-weixin-fiber-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let pollCalls = 0;
  let pollSignal: AbortSignal | undefined;
  const adapter = createWeixinAdapter({
    notifyConnection: async () => {},
    dataDir: () => dataDir,
    memoryDataDir: () => dataDir,
    readState: () => recoverableState(),
    writeState: () => {},
    pollUpdates: (_state, signal) => {
      pollCalls += 1;
      pollSignal = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
  });

  const dispose = await adapter.start() as MessageAdapterDispose;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(pollCalls, 1);
  await dispose();
  assert.equal(pollSignal?.aborted, true);
  const status = readStatus(dataDir).messageAdapters.weixin;
  assert.equal(status.status, "disabled");
  assert.equal(status.polling, false);
  assert.equal(status.loggedIn, false);
});

test("Weixin ignores a long-poll result that arrives after disposal", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-weixin-stale-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let resolvePoll: ((value: Record<string, unknown>) => void) | undefined;
  let pollSignal: AbortSignal | undefined;
  let writeCount = 0;
  let messageCount = 0;
  let dispatchCount = 0;
  const adapter = createWeixinAdapter({
    notifyConnection: async () => {},
    dataDir: () => dataDir,
    memoryDataDir: () => dataDir,
    readState: () => recoverableState(),
    writeState: () => { writeCount += 1; },
    pollUpdates: (_state, signal) => {
      pollSignal = signal;
      return new Promise((resolve) => { resolvePoll = resolve; });
    },
    appendMessage: () => { messageCount += 1; },
    dispatchRecord: async () => {
      dispatchCount += 1;
      return "forwarded";
    }
  });

  const dispose = await adapter.start() as MessageAdapterDispose;
  await new Promise<void>(resolve => setImmediate(resolve));
  const disposing = dispose();
  assert.equal(pollSignal?.aborted, true);
  resolvePoll?.({
    ret: 0,
    errcode: 0,
    get_updates_buf: "next",
    msgs: [{
      from_user_id: "user-1",
      message_id: "late-1",
      item_list: [{ type: 1, text_item: { text: "late" } }]
    }]
  });
  await disposing;

  assert.equal(writeCount, 0);
  assert.equal(messageCount, 0);
  assert.equal(dispatchCount, 0);
  assert.equal(readStatus(dataDir).messageAdapters.weixin.status, "disabled");
});

test("Weixin Fiber creates a fresh long poll for each mount", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-weixin-runtime-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const signals: AbortSignal[] = [];
  const dependencies: WeixinAdapterDependencies = {
    notifyConnection: async () => {},
    dataDir: () => dataDir,
    memoryDataDir: () => dataDir,
    readState: () => recoverableState(),
    writeState: () => {},
    pollUpdates: (_state, signal) => {
      if (signal) signals.push(signal);
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
  };
  const runtime = await createMessageAdapterRuntime([definition(dependencies)]);
  t.after(() => runtime.dispose());

  const first = await runtime.mount("weixin");
  await first.dispose();
  const second = await runtime.mount("weixin");
  await second.dispose();

  assert.equal(signals.length, 2);
  assert.deepEqual(signals.map((signal) => signal.aborted), [true, true]);
  assert.equal(readStatus(dataDir).messageAdapters.weixin.status, "disabled");
});

test("Weixin retirement retains an unfinished batch cursor and the replacement resumes without duplicate routing", { timeout: 10000 }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-weixin-handover-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let state: WeixinOpenClawState = { ...recoverableState(), syncBuf: "original-cursor" };
  const requested: Array<{ token: string | undefined; cursor: string | undefined }> = [];
  const routed: string[] = [];
  const recorded: string[] = [];
  let finishFirst!: () => void;
  const firstDelivery = new Promise<void>(resolve => { finishFirst = resolve; });
  let secondStarted!: () => void;
  const secondDownload = new Promise<void>(resolve => { secondStarted = resolve; });
  const batch = { ret: 0, get_updates_buf: "next-cursor", msgs: [
    { from_user_id: "user-1", message_id: "message-1", context_token: "first-context", item_list: [{ type: 1, text_item: { text: "first" } }] },
    { from_user_id: "user-2", message_id: "message-2", context_token: "second-context", item_list: [{ type: 1, text_item: { text: "second" } }] }
  ] };
  const adapter = createWeixinAdapter({
    notifyConnection: async () => {},
    dataDir: () => dataDir, memoryDataDir: () => dataDir,
    readState: () => structuredClone(state),
    writeState: (_dir, next) => { state = structuredClone(next); },
    pollUpdates: async (current, signal) => {
      requested.push({ token: current.token, cursor: current.syncBuf });
      if (requested.length <= 2) return batch;
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    },
    downloadImages: async (_items, _dir, messageId, _fetch, signal) => {
      if (messageId === "message-2" && requested.length === 1) {
        secondStarted();
        await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
      }
      return [];
    },
    appendMessage: (message, directory) => { recorded.push(String(message.messageId)); return appendWeixinMessageToDir(message, directory); },
    dispatchRecord: async message => {
      routed.push(String(message.messageId));
      if (message.messageId === "message-1") await firstDelivery;
      return "forwarded";
    }
  });
  const first = await adapter.start() as MessageAdapterDispose;
  let second: MessageAdapterDispose | undefined;
  try {
    await secondDownload;
    assert.deepEqual(recorded, ["message-1"]);
    let stopped = false;
    const closing = first();
    void Promise.resolve(closing).then(() => { stopped = true; });
    assert.equal(first(), closing);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false);
    assert.equal(state.syncBuf, "original-cursor");
    assert.deepEqual(state.contextTokens, { "user-1": "first-context" });
    finishFirst();
    await closing;

    second = await adapter.start() as MessageAdapterDispose;
    const deadline = Date.now() + 1500;
    while (requested.length < 3 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(requested, [
      { token: "runtime-token", cursor: "original-cursor" },
      { token: "runtime-token", cursor: "original-cursor" },
      { token: "runtime-token", cursor: "next-cursor" }
    ]);
    assert.deepEqual(recorded, ["message-1", "message-2"]);
    assert.deepEqual(routed, ["message-1", "message-2"]);
    assert.deepEqual(state.contextTokens, { "user-1": "first-context", "user-2": "second-context" });
  } finally {
    finishFirst();
    await first();
    await second?.();
  }
});

test("weixin owns an independent SDK package entry", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../../rabi.plugin.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.entries.gateway, { execution: "in_process", module: "./gateway.mjs" });
  assert.ok(manifest.provides.includes("endpoint.weixin@1"));
});

test("the built Weixin package reloads in the same Gateway with its stored login and committed cursor", { timeout: 120_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-native-hotplug-"));
  const host = new RabiCordisHost();
  const polls: Array<{ cursor: string; authenticated: boolean }> = [];
  const paths: string[] = [], forwarded: string[] = [];
  let finish!: () => void;
  const firstDelivery = new Promise<void>(resolve => { finish = resolve; });
  let oldPollClosed = false;
  const server = http.createServer(async (request, response) => {
    paths.push(request.url ?? "");
    if (request.url === "/ilink/bot/msg/notifystart" || request.url === "/ilink/bot/msg/notifystop") {
      response.end(JSON.stringify({ ret: 0 }));
      return;
    }
    if (request.url !== "/ilink/bot/getupdates") { response.writeHead(404).end(); return; }
    let body = "";
    for await (const chunk of request) body += chunk;
    polls.push({ cursor: JSON.parse(body).get_updates_buf, authenticated: request.headers.authorization === "Bearer runtime-token" });
    const count = polls.length;
    if (count === 2) { response.once("close", () => { oldPollClosed = true; }); return; }
    if (count === 1 || count === 3) response.end(JSON.stringify({ ret: 0, get_updates_buf: `cursor-${count}`,
      msgs: [{ from_user_id: "fixture-user", message_id: `message-${count}`, context_token: `context-${count}`,
        item_list: [{ type: 1, text_item: { text: "fixture message" } }] }] }));
  });
  const waitFor = async (check: () => boolean) => {
    const deadline = Date.now() + 20_000;
    while (!check()) {
      if (Date.now() >= deadline) throw new Error("Weixin fixture did not reach the expected state.");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    writeWeixinState(root, { ...recoverableState(), baseUrl, syncBuf: "original-cursor" });
    // @ts-expect-error The production builder is JavaScript outside src.
    const { buildPluginPackages } = await import("../../../../../scripts/build-plugin-packages.mjs");
    const packageId = "io.rabiroute.endpoint.weixin";
    const built = await buildPluginPackages(process.cwd(), { packages: [packageId], outputDirectory: path.join(root, "built") });
    const version = JSON.parse(fs.readFileSync(new URL("../../rabi.plugin.json", import.meta.url), "utf8")).version;
    const profilePath = path.join(root, "profile.json"), settingsRoot = path.join(root, "settings"), instanceId = "endpoint:weixin";
    fs.writeFileSync(profilePath, JSON.stringify({ schemaVersion: 2, readyRequires: [], instances: [
      { id: instanceId, package: packageId, version, enabled: true, config: {}, grants: [] }
    ] }));
    const settings = new PluginProfileSettings({ profilePath, settingsRoot });
    const initial: GatewayDefinition = { id: "weixin-fixture", gatewayPort: 0, enabled: true,
      messageAdapters: ["weixin"], weixinBaseUrl: baseUrl, weixinBotType: "3" };
    const shared = await createMessageEndpointHostPorts();
    const runtime = await mountGatewayEndpointPlugins(host, { initialRouteDefinition: initial, profilePath, stateRoot: root,
      settingsRoot, packageRoots: [built.packagesRoot], runtimeRoot: path.join(root, "runtime"), adapterTypes: ["weixin"], watch: false,
      hostPorts: { ...shared, module<T>(id: string): T {
        if (id === "config") return { config: { ...initial, dataDir: root, memoryDataDir: root } } as T;
        if (id === "forwarding") return { async forwardMessageWithCompletion(_kind: unknown, record: WeixinMessageRecord) {
          forwarded.push(String(record.messageId));
          if (forwarded.length === 1) await firstDelivery;
        } } as T;
        return shared.module<T>(id);
      } } });
    await waitFor(() => polls.length === 2 && forwarded.length === 1);
    const active = () => runtime.current().records.find(record => record.identity.instanceId === instanceId)!.identity;
    const original = active();
    await settings.update(instanceId, { expectedRevision: (await settings.snapshot()).revision, config: { fixtureRevision: 2 } });
    const swapping = runtime.reconcile();
    void swapping.catch(() => {});
    await waitFor(() => oldPollClosed);
    assert.equal(polls.length, 2);
    finish();
    await swapping;
    await waitFor(() => polls.length >= 4 && forwarded.length === 2);
    assert.deepEqual(polls.slice(0, 4), ["original-cursor", "cursor-1", "cursor-1", "cursor-3"].map(cursor => ({ cursor, authenticated: true })));
    assert.deepEqual(paths.filter(value => value.includes("/msg/")), [
      "/ilink/bot/msg/notifystart", "/ilink/bot/msg/notifystop", "/ilink/bot/msg/notifystart"
    ]);
    assert.equal(paths.some(value => value.includes("qrcode")), false);
    assert.deepEqual(forwarded, ["message-1", "message-3"]);
    assert.equal(readWeixinState(root, baseUrl).contextTokens["fixture-user"], "context-3");
    assert.equal(active().applicationGenerationId, original.applicationGenerationId);
    assert.notEqual(active().activationId, original.activationId);
  } finally {
    finish();
    await host.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
