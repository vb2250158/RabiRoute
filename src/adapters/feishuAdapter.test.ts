import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendFeishuMessageToDir } from "../history.js";
import { createMessageAdapterRuntime } from "../runtime/messageAdapterRuntime.js";
import { builtinMessageAdapterDefinitions } from "./builtinMessageAdapters.js";
import type { MessageAdapterDefinition, MessageAdapterDispose } from "./messageAdapter.js";
import {
  createFeishuAdapter,
  decryptFeishuCallback,
  handleFeishuCallback,
  verifyFeishuCallbackSignature,
  type FeishuAdapterDependencies,
  type FeishuAdapterSettings
} from "./feishuAdapter.js";

const verificationToken = "verification-token-for-test";
const encryptKey = "encrypt-key-for-test";
const nowSeconds = 1_700_000_000;

function callbackBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "2.0",
    header: {
      event_id: "evt-1",
      event_type: "im.message.receive_v1",
      create_time: String(nowSeconds),
      token: verificationToken
    },
    event: {
      sender: { sender_id: { open_id: "ou-user" } },
      message: {
        message_id: "om-message",
        chat_id: "oc-source-chat",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello from Feishu" })
      }
    },
    ...overrides
  };
}

function signed(rawBody: Buffer, timestamp = String(nowSeconds), nonce = "nonce-1") {
  const signature = createHash("sha256")
    .update(timestamp)
    .update(nonce)
    .update(encryptKey)
    .update(rawBody)
    .digest("hex");
  return { timestamp, nonce, signature };
}

function encrypt(body: Record<string, unknown>): string {
  const key = createHash("sha256").update(encryptKey).digest();
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  return Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(body), "utf8")),
    cipher.final()
  ]).toString("base64");
}

test("Feishu callback signature covers timestamp, nonce, Encrypt Key and raw body", () => {
  const rawBody = Buffer.from(JSON.stringify(callbackBody()));
  const headers = signed(rawBody);
  assert.equal(verifyFeishuCallbackSignature(rawBody, headers, encryptKey, nowSeconds), true);
  assert.equal(verifyFeishuCallbackSignature(Buffer.from("{}"), headers, encryptKey, nowSeconds), false);
  assert.equal(verifyFeishuCallbackSignature(rawBody, headers, "wrong-key", nowSeconds), false);
  assert.equal(verifyFeishuCallbackSignature(rawBody, headers, encryptKey, nowSeconds + 301), false);
});

test("Feishu URL challenge is authenticated by Verification Token without requiring a signature", () => {
  const result = handleFeishuCallback({
    rawBody: Buffer.from(JSON.stringify({
      type: "url_verification",
      challenge: "challenge-value",
      token: verificationToken
    })),
    headers: {},
    verificationToken,
    encryptKey,
    nowSeconds
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.disposition, "challenge");
  assert.deepEqual(result.responseBody, { challenge: "challenge-value" });
});

test("signed Feishu message persists once by event_id and preserves the source chat", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-feishu-"));
  const rawBody = Buffer.from(JSON.stringify(callbackBody()));
  const input = {
    rawBody,
    headers: signed(rawBody),
    verificationToken,
    encryptKey,
    nowSeconds,
    persist: (record: Parameters<typeof appendFeishuMessageToDir>[0]) =>
      appendFeishuMessageToDir(record, dir)
  };
  const accepted = handleFeishuCallback(input);
  const duplicateAfterFreshHandler = handleFeishuCallback(input);
  assert.equal(accepted.disposition, "accepted");
  assert.equal(accepted.record?.eventId, "evt-1");
  assert.equal(accepted.record?.chatId, "oc-source-chat");
  assert.equal(duplicateAfterFreshHandler.disposition, "duplicate");

  const lines = fs.readFileSync(path.join(dir, "feishu-messages.jsonl"), "utf8")
    .trim()
    .split(/\r?\n/);
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /verification-token-for-test/);
  assert.doesNotMatch(lines[0], /encrypt-key-for-test/);
});

test("Feishu message callback rejects missing, stale, or invalid signatures", () => {
  const rawBody = Buffer.from(JSON.stringify(callbackBody()));
  for (const headers of [
    {},
    signed(rawBody, String(nowSeconds - 301)),
    { ...signed(rawBody), signature: "0".repeat(64) }
  ]) {
    const result = handleFeishuCallback({
      rawBody,
      headers,
      verificationToken,
      encryptKey,
      nowSeconds
    });
    assert.equal(result.statusCode, 401);
    assert.equal(result.disposition, "invalid_signature");
  }
});

test("encrypted Feishu callbacks are verified and decrypted before dispatch", () => {
  const encrypted = encrypt(callbackBody());
  const rawBody = Buffer.from(JSON.stringify({ encrypt: encrypted }));
  assert.equal(decryptFeishuCallback(encrypted, encryptKey).schema, "2.0");
  const result = handleFeishuCallback({
    rawBody,
    headers: signed(rawBody),
    verificationToken,
    encryptKey,
    nowSeconds,
    persist: () => true
  });
  assert.equal(result.disposition, "accepted");
  assert.equal(result.record?.messageId, "om-message");
});

function settings(port: number): FeishuAdapterSettings {
  return {
    appId: "cli_test_app",
    appSecret: "app-secret-for-test",
    verificationToken,
    encryptKey,
    eventSubscriptionEnabled: true,
    webhookPath: "/callbacks/feishu",
    webhookPort: port
  };
}

function readStatus(dataDir: string) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, "gateway-status.json"), "utf8"));
}

function listen(server: http.Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Expected TCP server address."));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function request(input: {
  port: number;
  path: string;
  body: Buffer;
  headers?: Record<string, string>;
}): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: input.port,
      path: input.path,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(input.body.length),
        ...input.headers
      }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        statusCode: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    req.once("error", reject);
    req.end(input.body);
  });
}

function definition(dependencies: FeishuAdapterDependencies): MessageAdapterDefinition {
  return {
    manifest: {
      type: "feishu",
      label: "飞书",
      host: "gateway",
      transport: "http",
      lifecycle: "fiber"
    },
    create: () => createFeishuAdapter(dependencies)
  };
}

test("Feishu Fiber waits for listener readiness, forwards messages, and releases the port", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-feishu-runtime-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const probe = http.createServer();
  const port = await listen(probe);
  await close(probe);
  const forwarded: string[] = [];
  const dependencies: FeishuAdapterDependencies = {
    settings: () => settings(port),
    dataDir: () => dataDir,
    memoryDataDir: () => dataDir,
    now: () => new Date(nowSeconds * 1000),
    forward: (_kind, record) => forwarded.push(String((record as { messageId?: string }).messageId))
  };
  const runtime = await createMessageAdapterRuntime([definition(dependencies)]);
  t.after(() => runtime.dispose());

  const first = await runtime.mount("feishu");
  assert.equal(readStatus(dataDir).messageAdapters.feishu.listenerReady, true);
  const rawBody = Buffer.from(JSON.stringify(callbackBody()));
  const headers = signed(rawBody);
  const response = await request({
    port,
    path: settings(port).webhookPath,
    body: rawBody,
    headers: {
      "x-lark-request-timestamp": headers.timestamp,
      "x-lark-request-nonce": headers.nonce,
      "x-lark-signature": headers.signature
    }
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(forwarded, ["om-message"]);
  assert.equal(fs.existsSync(path.join(dataDir, "feishu-messages.jsonl")), true);

  await first.dispose();
  assert.equal(readStatus(dataDir).messageAdapters.feishu.status, "disabled");
  await assert.rejects(request({
    port,
    path: settings(port).webhookPath,
    body: Buffer.from("{}")
  }));

  const second = await runtime.mount("feishu");
  assert.equal(readStatus(dataDir).messageAdapters.feishu.listenerReady, true);
  await second.dispose();
});

test("Feishu listener conflict rejects Cordis mount and records failure", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-feishu-conflict-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const blocker = http.createServer();
  const port = await listen(blocker);
  t.after(() => close(blocker));
  const runtime = await createMessageAdapterRuntime([definition({
    settings: () => settings(port),
    dataDir: () => dataDir,
    memoryDataDir: () => dataDir
  })]);
  t.after(() => runtime.dispose());

  await assert.rejects(runtime.mount("feishu"), /EADDRINUSE/);
  const status = readStatus(dataDir).messageAdapters.feishu;
  assert.equal(status.status, "failed");
  assert.equal(status.listenerReady, false);
  assert.match(status.lastError, /EADDRINUSE/);
});

test("Feishu disposal cancels an incomplete callback before persistence or forwarding", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-feishu-late-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const probe = http.createServer();
  const port = await listen(probe);
  await close(probe);
  const forwarded: string[] = [];
  const adapter = createFeishuAdapter({
    settings: () => settings(port),
    dataDir: () => dataDir,
    memoryDataDir: () => dataDir,
    now: () => new Date(nowSeconds * 1000),
    forward: () => forwarded.push("forwarded")
  });
  const dispose = await adapter.start() as MessageAdapterDispose;

  const requestError = new Promise<Error>((resolve) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: settings(port).webhookPath,
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "4096" }
    });
    req.once("error", resolve);
    req.flushHeaders();
    req.write("{");
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await dispose();
  await requestError;

  assert.deepEqual(forwarded, []);
  assert.equal(fs.existsSync(path.join(dataDir, "feishu-messages.jsonl")), false);
  assert.equal(readStatus(dataDir).messageAdapters.feishu.status, "disabled");
});

test("Feishu missing configuration does not create a server", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-feishu-missing-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let createServerCalls = 0;
  const adapter = createFeishuAdapter({
    settings: () => ({ ...settings(0), appSecret: "", eventSubscriptionEnabled: false }),
    dataDir: () => dataDir,
    memoryDataDir: () => dataDir,
    createServer: (listener) => {
      createServerCalls += 1;
      return http.createServer(listener);
    }
  });

  const dispose = await adapter.start();
  assert.equal(createServerCalls, 0);
  assert.equal(readStatus(dataDir).messageAdapters.feishu.status, "blocked");
  await dispose?.();
});

test("built-in Message Adapter manifests include Feishu", () => {
  assert.deepEqual(
    builtinMessageAdapterDefinitions().find((item) => item.manifest.type === "feishu")?.manifest,
    {
      type: "feishu",
      label: "飞书",
      host: "gateway",
      transport: "http",
      lifecycle: "fiber"
    }
  );
});


test("Feishu status write failure does not suppress an accepted message", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-feishu-status-failure-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const probe = http.createServer();
  const port = await listen(probe);
  await close(probe);
  const forwarded: string[] = [];
  const previousConsoleError = console.error;
  console.error = () => {};
  t.after(() => { console.error = previousConsoleError; });
  const adapter = createFeishuAdapter({
    settings: () => settings(port),
    dataDir: () => dataDir,
    memoryDataDir: () => dataDir,
    now: () => new Date(nowSeconds * 1000),
    forward: (_kind, record) => forwarded.push(String((record as { messageId?: string }).messageId))
  });
  const dispose = await adapter.start() as MessageAdapterDispose;
  const statusPath = path.join(dataDir, "gateway-status.json");
  fs.rmSync(statusPath, { force: true });
  fs.mkdirSync(statusPath);

  const rawBody = Buffer.from(JSON.stringify(callbackBody({
    header: {
      ...callbackBody().header as Record<string, unknown>,
      event_id: "evt-status-failure"
    },
    event: {
      ...callbackBody().event as Record<string, unknown>,
      message: {
        ...((callbackBody().event as Record<string, unknown>).message as Record<string, unknown>),
        message_id: "om-status-failure"
      }
    }
  })));
  const headers = signed(rawBody);
  const response = await request({
    port,
    path: settings(port).webhookPath,
    body: rawBody,
    headers: {
      "x-lark-request-timestamp": headers.timestamp,
      "x-lark-request-nonce": headers.nonce,
      "x-lark-signature": headers.signature
    }
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(forwarded, ["om-status-failure"]);
  assert.equal(fs.readFileSync(path.join(dataDir, "feishu-messages.jsonl"), "utf8").trim().length > 0, true);
  fs.rmSync(statusPath, { recursive: true, force: true });
  await dispose();
});

test("concurrent Feishu disposal callers await the same listener close", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-feishu-concurrent-dispose-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  class DelayedCloseServer extends EventEmitter {
    listening = false;

    listen(...args: unknown[]): this {
      this.listening = true;
      const candidate = args[args.length - 1];
      const callback = typeof candidate === "function" ? candidate as () => void : undefined;
      queueMicrotask(() => callback?.());
      return this;
    }

    close(callback?: (error?: Error) => void): this {
      setTimeout(() => {
        this.listening = false;
        callback?.();
      }, 40);
      return this;
    }

    closeAllConnections(): void {}
  }

  const server = new DelayedCloseServer();
  const adapter = createFeishuAdapter({
    settings: () => settings(0),
    dataDir: () => dataDir,
    memoryDataDir: () => dataDir,
    createServer: () => server as unknown as http.Server
  });
  const dispose = await adapter.start() as MessageAdapterDispose;

  const first = dispose() as Promise<void>;
  const second = dispose() as Promise<void>;
  assert.equal(first, second);
  let secondCompleted = false;
  void second.then(() => { secondCompleted = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(secondCompleted, false);
  assert.equal(server.listening, true);
  await Promise.all([first, second]);
  assert.equal(server.listening, false);
});
