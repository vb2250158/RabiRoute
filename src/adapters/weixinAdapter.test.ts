import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { WeixinMessageRecord } from "../history.js";
import { createMessageAdapterRuntime } from "../runtime/messageAdapterRuntime.js";
import type { WeixinOpenClawState } from "../weixinOpenClaw.js";
import { builtinMessageAdapterDefinitions } from "./builtinMessageAdapters.js";
import type { MessageAdapterDefinition, MessageAdapterDispose } from "./messageAdapter.js";
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

test("personal Weixin forwards text and downloaded images, but records unreadable media", () => {
  const calls: string[] = [];
  const handlers = {
    forward: () => calls.push("forward"),
    recordOnly: () => {
      calls.push("record");
      return 1;
    }
  };

  assert.equal(dispatchWeixinRecord(record(), {}, handlers), "forwarded");
  assert.equal(dispatchWeixinRecord(record({ messageType: "image", rawMessage: "[图片]" }), {}, handlers), "record_only");
  assert.equal(dispatchWeixinRecord(record({
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
    dataDir: () => dataDir,
    memoryDataDir: () => dataDir,
    readState: () => recoverableState(),
    writeState: () => { writeCount += 1; },
    pollUpdates: (_state, signal) => {
      pollSignal = signal;
      return new Promise((resolve) => { resolvePoll = resolve; });
    },
    appendMessage: () => { messageCount += 1; },
    dispatchRecord: () => {
      dispatchCount += 1;
      return "forwarded";
    }
  });

  const dispose = await adapter.start() as MessageAdapterDispose;
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

test("built-in Message Adapter manifests include Weixin", () => {
  assert.deepEqual(
    builtinMessageAdapterDefinitions().find((definition) => definition.manifest.type === "weixin")?.manifest,
    {
      type: "weixin",
      label: "个人微信",
      host: "gateway",
      transport: "http",
      lifecycle: "fiber"
    }
  );
});
