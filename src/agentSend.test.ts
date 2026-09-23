import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AGENT_SEND_CHANNEL_HELP, AGENT_SEND_REQUEST_CONTRACT, agentSendChannelHelp, handleAgentSend, inspectAgentSendDelivery, prepareAgentSendRequest, type AgentSendRequest } from "./agentSend.js";
import type { AgentReplyOptions } from "./outbox.js";

test("channel discovery is deeply immutable and matches accepted channel examples", () => {
  const assertFrozen = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    assert.ok(Object.isFrozen(value));
    for (const child of Object.values(value)) assertFrozen(child);
  };
  assertFrozen(AGENT_SEND_CHANNEL_HELP);
  assert.equal(new Set(AGENT_SEND_CHANNEL_HELP.map(item => item.channel)).size, AGENT_SEND_CHANNEL_HELP.length);
  for (const help of AGENT_SEND_CHANNEL_HELP) {
    assert.equal(agentSendChannelHelp(help.channel), help);
    assert.throws(() => prepareAgentSendRequest({
      deliveryId: "example-delivery", sender: { agentType: "dsh", sessionId: "example-session" },
      routeId: "example-route", ...help.example,
      params: { ...(help.example.params as Record<string, unknown>), unsupportedField: true }
    }), /params contains unsupported fields: unsupportedField/);
    assert.doesNotThrow(() => prepareAgentSendRequest({
      deliveryId: "example-delivery", sender: { agentType: "dsh", sessionId: "example-session" },
      routeId: "example-route", ...help.example
    }));
  }
  assert.equal(agentSendChannelHelp("qq"), undefined);
  assert.equal(Reflect.set(AGENT_SEND_CHANNEL_HELP[0], "channel", "qq"), false);
});

test("partial request field contract is frozen and shares the parser allowlists", () => {
  const contract = AGENT_SEND_REQUEST_CONTRACT;
  const assertFrozen = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    assert.ok(Object.isFrozen(value));
    for (const child of Object.values(value)) assertFrozen(child);
  };
  assertFrozen(contract);
  assert.equal(contract.kind, "partial-field-allowlist");
  assert.ok(contract.missing.length > 0);
  assert.equal("schema" in contract, false);
  assert.deepEqual(contract.channelValues, AGENT_SEND_CHANNEL_HELP.map(item => item.channel));
  for (const help of AGENT_SEND_CHANNEL_HELP) {
    assert.deepEqual(contract.paramsAllowedFields[help.channel], Object.keys(help.params));
  }
  const base = {
    deliveryId: "contract-delivery", sender: { agentType: "dsh", sessionId: "contract-session" },
    routeId: "contract-route", channel: "speech", params: {}, payload: { type: "text", text: "hello" }
  };
  for (const section of ["request", "sender", "payload"] as const) {
    const allowed: readonly string[] = contract.allowedFields[section];
    assert.equal(allowed.includes("unsupportedField"), false);
    const extra = section === "request" ? { ...base, unsupportedField: true }
      : { ...base, [section]: { ...base[section], unsupportedField: true } };
    assert.throws(() => prepareAgentSendRequest(extra), {
      message: `${section} contains unsupported fields: unsupportedField.`
    });
    // An allowed key may fail value checks, but must never fail the field-name allowlist.
    for (const field of allowed) {
      const candidate = section === "request" ? { ...base, [field]: undefined }
        : { ...base, [section]: { ...base[section], [field]: undefined } };
      try { prepareAgentSendRequest(candidate); } catch (error) {
        assert.doesNotMatch(String(error), /contains unsupported fields/);
      }
    }
  }
  assert.throws(() => prepareAgentSendRequest({ ...base, sender: {}, payload: { unsupportedField: true } }), /Missing sender.agentType/);
  assert.throws(() => prepareAgentSendRequest({ ...base, params: { unsupportedField: true }, payload: { unsupportedField: true } }), /payload contains unsupported fields/);
  assert.doesNotThrow(() => prepareAgentSendRequest({ ...base, deliveryId: 123, payload: { type: "text", text: 456, path: "example-path", url: "https://example.invalid/file" } }));
});

async function withJsonServer(
  handler: (body: Record<string, unknown>, request: http.IncomingMessage) => Record<string, unknown>,
  run: (url: string) => Promise<void>
): Promise<void> {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(handler(body, request)));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function options(rootDir: string, endpointUrl: string, speechServiceUrl?: string): AgentReplyOptions {
  return {
    rootDir,
    routeRoot: path.join(rootDir, "data", "route"),
    rolesRoot: path.join(rootDir, "data", "roles"),
    speechServiceUrl,
    runtimes: [{
      id: "route-main",
      enabled: true,
      pipeline: { outputAdapter: "tts" },
      napcatInstances: [{ id: "qq-main", httpUrl: endpointUrl, accessToken: "", enabled: true }],
      messageAdapterPolicies: {
        napcat: { outputEnabled: true, supportedOutputs: ["text"] },
        speech: { outputEnabled: true, supportedOutputs: ["text"] }
      }
    }]
  };
}

test("strict send contract rejects missing explicit channel parameters", () => {
  assert.throws(() => prepareAgentSendRequest({
    deliveryId: "send-no-sender",
    routeId: "route-main",
    channel: "napcat",
    params: { target: "group", groupId: "456" },
    payload: { type: "text", text: "hello" }
  }), /sender/);
  assert.throws(() => prepareAgentSendRequest({
    deliveryId: "send-no-session",
    sender: { agentType: "codex" },
    routeId: "route-main",
    channel: "napcat",
    params: { target: "group", groupId: "456" },
    payload: { type: "text", text: "hello" }
  }), /sender\.sessionId/);
  assert.throws(() => prepareAgentSendRequest({
    deliveryId: "send-1",
    sender: { agentType: "codex", sessionId: "thread-send-1" },
    routeId: "route-main",
    channel: "napcat",
    params: { target: "group" },
    payload: { type: "text", text: "hello" }
  }), /params\.groupId/);
  assert.throws(() => prepareAgentSendRequest({
    deliveryId: "send-2",
    sender: { agentType: "codex", sessionId: "thread-send-2" },
    routeId: "route-main",
    params: {},
    payload: { type: "text", text: "hello" }
  }), /channel/);
  assert.throws(() => prepareAgentSendRequest({
    deliveryId: "send-legacy",
    sender: { agentType: "codex", sessionId: "thread-send-legacy" },
    routeId: "route-main",
    channel: "napcat",
    params: { target: "group", groupId: "456" },
    payload: { type: "text", text: "hello" },
    replyContext: { targetType: "group" }
  } as unknown as AgentSendRequest), /unsupported fields: replyContext/);
  assert.throws(() => prepareAgentSendRequest({
    deliveryId: "send-invalid-style-mode",
    sender: { agentType: "codex", sessionId: "thread-invalid-style-mode" },
    routeId: "route-main",
    channel: "napcat",
    styleValidation: 2,
    params: { target: "group", groupId: "456", replyToMessageId: "" },
    payload: { type: "text", text: "hello" }
  }), /styleValidation must be 1 .* or 0/);
});

test("NapCat group sends require an explicit reply choice", () => {
  assert.throws(() => prepareAgentSendRequest({
    deliveryId: "group-send-without-reply-choice",
    sender: { agentType: "codex", sessionId: "codex-thread-1" },
    routeId: "route-main",
    channel: "napcat",
    params: { target: "group", groupId: "456" },
    payload: { type: "text", text: "naked progress update" }
  }), /NapCat group sends must include params\.replyToMessageId.*use the source QQ message ID.*empty string.*intentional unquoted group message/i);

  assert.doesNotThrow(() => prepareAgentSendRequest({
    deliveryId: "group-send-with-empty-reply-choice",
    sender: { agentType: "codex", sessionId: "codex-thread-1" },
    routeId: "route-main",
    channel: "napcat",
    params: { target: "group", groupId: "456", replyToMessageId: "" },
    payload: { type: "text", text: "intentional unquoted group update" }
  }));

  assert.throws(() => prepareAgentSendRequest({
    deliveryId: "message-processing-group-send-with-empty-reply-choice",
    sender: { agentType: "message_processing", sessionId: "message-processing-thread-1" },
    routeId: "route-main",
    channel: "napcat",
    params: { target: "group", groupId: "456", replyToMessageId: "" },
    payload: { type: "text", text: "message processing must quote its source" }
  }), /message_processing.*non-empty params\.replyToMessageId/i);

  const intentionalFollowUp = prepareAgentSendRequest({
    deliveryId: "group-send-intentional-follow-up",
    sender: { agentType: "codex", sessionId: "codex-thread-1" },
    routeId: "route-main",
    channel: "napcat",
    params: { target: "group", groupId: "456", replyToMessageId: "123", allowAdditionalReply: true },
    payload: { type: "text", text: "new evidence after the first reply" }
  });
  assert.equal(intentionalFollowUp.allowAdditionalReply, true);
  assert.throws(() => prepareAgentSendRequest({
    deliveryId: "group-send-invalid-follow-up-flag",
    sender: { agentType: "codex", sessionId: "codex-thread-1" },
    routeId: "route-main",
    channel: "napcat",
    params: { target: "group", groupId: "456", replyToMessageId: "123", allowAdditionalReply: "yes" },
    payload: { type: "text", text: "invalid follow-up flag" }
  }), /params\.allowAdditionalReply must be a boolean/i);
});

test("explicit NapCat send cannot be redirected to speech by the Route default pipeline", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-send-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const routeDataDir = path.join(rootDir, "data", "route", "route-main");
  fs.mkdirSync(routeDataDir, { recursive: true });
  fs.writeFileSync(path.join(routeDataDir, "group-messages.jsonl"), `${JSON.stringify({
    messageId: "123",
    groupId: "456",
    userId: "789",
    botUserId: "999",
    adapterType: "napcat"
  })}\n`, "utf8");
  let napcatBody: Record<string, unknown> = {};
  let napcatPath = "";
  await withJsonServer((body, request) => {
    napcatBody = body;
    napcatPath = request.url || "";
    return { status: "ok", retcode: 0, data: { message_id: 7788 } };
  }, async (url) => {
    const request: AgentSendRequest = {
      deliveryId: "send-napcat-1",
      sender: { agentType: "codex", sessionId: "thread-napcat-1" },
      routeId: "route-main",
      channel: "napcat",
      params: { target: "group", groupId: "456", instanceId: "qq-main", replyToMessageId: "123" },
      payload: { type: "text", text: "明确发到 QQ 群。" }
    };
    const result = await handleAgentSend(request, options(rootDir, url));

    assert.equal(result.status, "sent");
    assert.equal(result.channel, "napcat");
    assert.deepEqual(result.sender, { agentType: "codex", sessionId: "thread-napcat-1" });
    assert.equal(result.groupId, "456");
    assert.equal(result.sentMessageId, "7788");
    assert.equal(napcatPath, "/send_group_msg");
    assert.equal(napcatBody.group_id, 456);
    assert.match(String(napcatBody.message), /CQ:reply,id=123/);
    assert.match(String(napcatBody.message), /CQ:at,qq=789/);
    const outboxRows = fs.readFileSync(
      path.join(rootDir, "data", "route", "route-main", "outbox-adapter.log.jsonl"),
      "utf8"
    ).trim().split(/\r?\n/).map(line => JSON.parse(line) as Record<string, unknown>);
    const requested = outboxRows.find(row => row.event === "send_requested");
    const loggedRequest = (requested?.data as Record<string, unknown> | undefined)?.request as Record<string, unknown> | undefined;
    assert.equal(loggedRequest?.senderAgentType, "codex");
    assert.equal(loggedRequest?.senderSessionId, "thread-napcat-1");
  });
});

test("a NapCat reply to an image message requires descriptions and archives them after sending", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-send-image-review-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const routeDataDir = path.join(rootDir, "data", "route", "route-main");
  const mediaDir = path.join(routeDataDir, "napcat-media", "qq-main", "image-source-1");
  fs.mkdirSync(mediaDir, { recursive: true });
  const imagePath = path.join(mediaDir, "01-dynamic-background.png");
  fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(routeDataDir, "group-messages.jsonl"), `${JSON.stringify({
    messageId: "image-source-1",
    groupId: "456",
    userId: "789",
    instanceId: "qq-main",
    adapterType: "napcat",
    rawMessage: "[CQ:image,file=dynamic-background.png]",
    attachments: [{
      id: "image-source-1:image:1",
      kind: "image",
      name: "dynamic-background.png",
      status: "ready",
      path: imagePath,
      sourceMessageId: "image-source-1"
    }]
  })}\n`, "utf8");
  let sends = 0;
  await withJsonServer(() => {
    sends += 1;
    return { status: "ok", retcode: 0, data: { message_id: 8899 } };
  }, async (url) => {
    const base: AgentSendRequest = {
      deliveryId: "send-image-review-1",
      sender: { agentType: "message_processing", sessionId: "thread-image-review-1" },
      routeId: "route-main",
      channel: "napcat",
      params: {
        target: "group",
        groupId: "456",
        instanceId: "qq-main",
        replyToMessageId: "image-source-1"
      },
      payload: { type: "text", text: "这个底框需要跟随动态文字宽度变化。" }
    };
    await assert.rejects(
      () => handleAgentSend(base, options(rootDir, url)),
      /params\.replyImageDescriptions must contain 1 descriptions/i
    );
    assert.equal(sends, 0);

    const result = await handleAgentSend({
      ...base,
      params: {
        ...(base.params as Record<string, unknown>),
        replyImageDescriptions: ["图片展示同一条动态文字变长后，灰色底框也随内容扩展，想表达背景需要自适应宽度。"]
      }
    }, options(rootDir, url));
    assert.equal(result.status, "sent");
    assert.equal(sends, 1);
    assert.equal(result.replyImageDescriptionArchive?.sourceMessageId, "image-source-1");
    assert.deepEqual(result.replyImageDescriptionArchive?.files.map((item) => item.descriptionFile), [
      "data/route/route-main/napcat-media/qq-main/image-source-1/01-dynamic-background.md"
    ]);
    const descriptionPath = path.join(mediaDir, "01-dynamic-background.md");
    assert.match(fs.readFileSync(descriptionPath, "utf8"), /背景需要自适应宽度/);
    assert.match(fs.readFileSync(descriptionPath, "utf8"), /8899/);
  });
});

const managedFileId = "ed45711a-cd60-4ddf-b875-219b814a1ddc";
const fileSha256 = "a".repeat(64);
function managedFileRequest(): AgentSendRequest {
  return {
    deliveryId: "managed-file-delivery",
    sender: { agentType: "primary_persona", sessionId: "managed-file-session" },
    routeId: "route-main",
    channel: "napcat",
    params: { target: "group", groupId: "456", replyToMessageId: "" },
    payload: { type: "file", fileId: managedFileId, fileSha256, text: "file caption" }
  };
}

test("managed fileId is strict and limited to NapCat group files", () => {
  const base = managedFileRequest();
  for (const payload of [
    { type: "image", fileId: managedFileId, fileSha256 }, { type: "voice", fileId: managedFileId, fileSha256 },
    { type: "text", text: "text", fileId: managedFileId, fileSha256 }, { type: "file", fileId: "../file" },
    { type: "file", fileId: null }, { type: "file", fileId: managedFileId, fileSha256, path: "" },
    { type: "file", fileId: managedFileId, fileSha256, url: "https://example.invalid/file" },
    { type: "file", fileId: managedFileId, fileSha256, fileName: "override.txt" }
  ]) assert.throws(() => prepareAgentSendRequest({ ...base, payload }), /fileId/);
  for (const channel of ["wecom", "weixin", "feishu", "speech", "fennenote", "rabilink", "role_panel", "plan_feedback"]) {
    assert.throws(() => prepareAgentSendRequest({ ...base, channel }), /fileId/);
  }
  assert.throws(() => prepareAgentSendRequest({ ...base, params: { target: "private", userId: "123" } }), /fileId/);
  assert.throws(() => prepareAgentSendRequest({ ...base, withManagedGroupFile: "callback" } as AgentSendRequest), /unsupported fields/);
  assert.equal((prepareAgentSendRequest(base).internal.payload as Record<string, unknown>).fileId, managedFileId);
  assert.equal((prepareAgentSendRequest(base).internal.payload as Record<string, unknown>).fileSha256, fileSha256);
  for (const hash of [undefined, null, "", "A".repeat(64), "a".repeat(63), "g".repeat(64)]) {
    assert.throws(() => prepareAgentSendRequest({ ...base, payload: { type: "file", fileId: managedFileId, fileSha256: hash } }), /fileSha256/);
  }
  assert.throws(() => prepareAgentSendRequest({ ...base, payload: { type: "file", path: "file.txt", fileSha256 } }), /fileSha256 requires/);
});

test("managed group file lease covers upload and caption; readback retains fileId without resolving", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-managed-file-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const filePath = path.join(rootDir, "private-upload.bin");
  fs.writeFileSync(filePath, "managed file");
  let leased = false;
  let resolutions = 0;
  const actions: string[] = [];
  await withJsonServer((body, request) => {
    assert.equal(leased, true);
    actions.push(request.url!);
    if (request.url === "/upload_group_file") {
      assert.equal(body.file, filePath);
      assert.equal(body.name, "public.txt");
      return { status: "ok", retcode: 0, data: { file_id: "qq-file-1", file_name: filePath } };
    }
    return { status: "failed", retcode: 1, wording: filePath };
  }, async url => {
    const opts = options(rootDir, url);
    opts.runtimes[0].messageAdapterPolicies!.napcat = { outputEnabled: true, supportedOutputs: ["file"], allowedFileRoots: [] };
    opts.withManagedGroupFile = async (id, expectedSha256, send) => {
      assert.equal(id, managedFileId);
      assert.equal(expectedSha256, fileSha256);
      resolutions++;
      leased = true;
      try { return await send({ path: filePath, fileName: "public.txt" }); }
      finally { leased = false; }
    };
    const request = managedFileRequest();
    const result = await handleAgentSend(request, opts);
    assert.equal(result.status, "sent");
    assert.match(result.reason!, /follow-up text failed/);
    assert.equal(result.sentFileName, "public.txt");
    assert.deepEqual(actions, ["/upload_group_file", "/send_group_msg"]);
    assert.equal(leased, false);
    const log = fs.readFileSync(path.join(opts.routeRoot, "route-main", "outbox-adapter.log.jsonl"), "utf8");
    assert.ok(log.includes(managedFileId));
    assert.ok(!log.includes("private-upload.bin"));
    assert.ok(!JSON.stringify(result).includes("private-upload.bin"));
    fs.unlinkSync(filePath);
    delete opts.withManagedGroupFile;
    const readback = await inspectAgentSendDelivery(request, opts);
    assert.equal(readback.state, "completed");
    if (readback.state === "completed") assert.equal(readback.result.status, "sent");
    assert.equal(resolutions, 1);
    assert.equal((await inspectAgentSendDelivery({ ...request, payload: { type: "file", fileId: managedFileId, fileSha256: "b".repeat(64), text: "file caption" } }, opts)).state, "uncertain");
    assert.equal((await inspectAgentSendDelivery({ ...request, payload: { type: "file", fileId: "ed45711a-cd60-4ddf-b875-219b814a1ddd", fileSha256, text: "file caption" } }, opts)).state, "uncertain");
  });
});

test("managed uploads without platform receipt remain uncertain and lease-release errors stay sent", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-managed-receipt-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const filePath = path.join(rootDir, "private-file.bin");
  fs.writeFileSync(filePath, "file");
  let uploads = 0;
  await withJsonServer((_body, request) => {
    assert.equal(request.url, "/upload_group_file");
    uploads++;
    return { status: "ok", retcode: 0, data: {} };
  }, async url => {
    const opts = options(rootDir, url);
    opts.runtimes[0].messageAdapterPolicies!.napcat = { outputEnabled: true, supportedOutputs: ["file"] };
    opts.withManagedGroupFile = async (_id, _expectedSha256, send) => {
      await send({ path: filePath, fileName: "file.txt" });
      throw new Error(`Release failure: ${filePath}`);
    };
    const request = { ...managedFileRequest(), payload: { type: "file", fileId: managedFileId, fileSha256 } };
    const result = await handleAgentSend(request, opts);
    assert.equal(result.status, "sent");
    assert.equal(result.sentFileId, undefined);
    assert.ok(!JSON.stringify(result).includes("private-file.bin"));
    assert.equal((await inspectAgentSendDelivery(request, opts)).state, "uncertain");
    assert.equal(uploads, 1);
  });
});

test("managed group files fail closed without resolver, owner authority, or output policy", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-managed-denied-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  let sends = 0;
  await withJsonServer(() => { sends++; return {}; }, async url => {
    const opts = options(rootDir, url);
    opts.runtimes[0].messageAdapterPolicies!.napcat = { outputEnabled: true, supportedOutputs: ["file"] };
    assert.match((await handleAgentSend(managedFileRequest(), opts)).reason!, /resolver is unavailable/);
    let resolutions = 0;
    opts.withManagedGroupFile = async () => { resolutions++; throw new Error(`Owner denied: ${rootDir}`); };
    const denied = await handleAgentSend({ ...managedFileRequest(), deliveryId: "owner-denied" }, opts);
    assert.equal(denied.status, "failed");
    assert.equal(denied.reason, "Managed group file delivery failed.");
    opts.runtimes[0].messageAdapterPolicies!.napcat.outputEnabled = false;
    assert.equal((await handleAgentSend({ ...managedFileRequest(), deliveryId: "disabled" }, opts)).status, "blocked");
    opts.runtimes[0].messageAdapterPolicies!.napcat = { outputEnabled: true, supportedOutputs: ["text"] };
    assert.equal((await handleAgentSend({ ...managedFileRequest(), deliveryId: "unsupported" }, opts)).status, "blocked");
    assert.equal(resolutions, 1);
    assert.equal(sends, 0);
  });
});

test("a managed plan attachment image is sent through the resolver port only", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-plan-attachment-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  // Deliberately outside any allowedFileRoots, mirroring the real plan attachment layout.
  const attachmentDir = path.join(rootDir, "data", "roles", "XinghaiBuilder", "plans", "active", "plan-abc", "attachments");
  fs.mkdirSync(attachmentDir, { recursive: true });
  const imagePath = path.join(attachmentDir, "attachment-shot-1.png");
  fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  let sentBody: Record<string, unknown> | undefined;
  await withJsonServer((body) => {
    sentBody = body;
    return { status: "ok", retcode: 0, data: { message_id: "plan-attachment-1" } };
  }, async url => {
    const opts = options(rootDir, url);
    opts.runtimes[0].messageAdapterPolicies!.napcat = {
      outputEnabled: true,
      supportedOutputs: ["text", "image"],
      // The plan attachment directory is intentionally NOT an allowedFileRoot.
      allowedFileRoots: []
    };
    const request: AgentSendRequest = {
      deliveryId: "send-plan-attachment-1",
      sender: { agentType: "codex", sessionId: "thread-plan-attachment-1" },
      routeId: "route-main",
      channel: "napcat",
      params: { target: "group", groupId: "474222421", instanceId: "qq-main", replyToMessageId: "" },
      payload: {
        type: "image",
        text: "[CQ:at,qq=1050739541] 这是截图。",
        planAttachment: { roleId: "XinghaiBuilder", planId: "plan-abc", attachmentId: "shot-1" }
      }
    };

    // Without the port the send must fail closed rather than read an unvalidated path.
    assert.match((await handleAgentSend(request, opts)).reason ?? "", /plan attachment resolver is unavailable|Managed plan attachment resolver is unavailable/);

    let observed: { path: string; fileName: string } | undefined;
    opts.withManagedPlanAttachment = async (reference, send) => {
      assert.deepEqual(reference, { roleId: "XinghaiBuilder", planId: "plan-abc", attachmentId: "shot-1" });
      return await send({ path: imagePath, fileName: "attachment-shot-1.png" });
    };
    const result = await handleAgentSend({ ...request, deliveryId: "send-plan-attachment-2" }, opts);
    assert.equal(result.status, "sent", JSON.stringify({ status: result.status, reason: result.reason }));
    observed = { path: imagePath, fileName: "attachment-shot-1.png" };
    assert.ok(observed);
  });

  // The real at segment must survive alongside the resolved image segment.
  assert.deepEqual(sentBody?.message, [
    { type: "at", data: { qq: "1050739541" } },
    { type: "text", data: { text: " 这是截图。" } },
    { type: "image", data: { file: imagePath } }
  ]);
});

test("plan attachment payloads are rejected for text and voice kinds", () => {
  const base = {
    deliveryId: "send-plan-attachment-invalid",
    sender: { agentType: "codex", sessionId: "thread-plan-attachment-invalid" },
    routeId: "route-main",
    channel: "napcat" as const,
    params: { target: "group", groupId: "474222421" }
  };
  assert.throws(
    () => prepareAgentSendRequest({ ...base, payload: { type: "text", text: "hi", planAttachment: { planId: "p", attachmentId: "a" } } }),
    /only supported for image or file payloads/
  );
  assert.throws(
    () => prepareAgentSendRequest({ ...base, payload: { type: "voice", path: "x.wav", planAttachment: { planId: "p", attachmentId: "a" } } }),
    /only supported for image or file payloads/
  );
  assert.throws(
    () => prepareAgentSendRequest({ ...base, payload: { type: "image", planAttachment: { planId: "p" } } }),
    /requires payload\.planAttachment\.attachmentId/
  );
  assert.throws(
    () => prepareAgentSendRequest({ ...base, payload: { type: "image", path: "x.png", planAttachment: { planId: "p", attachmentId: "a" } } }),
    /cannot be combined with payload\.path/
  );
  assert.throws(
    () => prepareAgentSendRequest({ ...base, payload: { type: "image", planAttachment: { planId: "p", attachmentId: "a", extra: 1 } } }),
    /unsupported fields: extra/
  );
});

test("speech is used only when the request explicitly selects the speech channel", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-send-speech-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  let speechPath = "";
  await withJsonServer((_body, request) => {
    speechPath = request.url || "";
    return {};
  }, async (speechUrl) => {
    const result = await handleAgentSend({
      deliveryId: "send-speech-1",
      sender: { agentType: "codex", sessionId: "thread-speech-1" },
      routeId: "route-main",
      channel: "speech",
      params: { sessionId: "speech-session-1" },
      payload: { type: "text", text: "只进入语音合成。" }
    }, options(rootDir, "http://127.0.0.1:1", speechUrl));

    assert.equal(result.status, "sent");
    assert.equal(result.channel, "speech");
    assert.equal(result.targetType, "voice_transcript");
    assert.equal(speechPath, "/v1/audio/speech");
  });
});
