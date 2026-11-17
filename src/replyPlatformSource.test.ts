import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { MessageEndpointEgressProvider } from "@rabiroute/plugin-sdk";
import { handleAgentSend, prepareAgentSendRequest, validateAgentSendReplyImageDescriptions } from "./agentSend.js";
import type { AgentReplyOptions } from "./outbox.js";
import { readPlatformReplySource } from "./replyPlatformSource.js";
import { readReplySource } from "./plugins/io.rabiroute.endpoint.napcat/src/napcatReplySource.js";

function fixture(t: test.TestContext, image = false) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-platform-quote-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const dataDir = path.join(rootDir, "route");
  const calls: string[] = [];
  const transport: typeof fetch = async (url, init) => {
    const action = new URL(String(url)).pathname.slice(1); calls.push(action);
    if (action === "get_msg") {
      assert.deepEqual(JSON.parse(String(init?.body)), { message_id: "101" });
      return Response.json({ status: "ok", retcode: 0, data: { message_id: "101", message_type: "group", group_id: "202",
        message: image ? [{ type: "image", data: { url: "https://media.example/image.png" } }]
          : [{ type: "file", data: { file_id: "file-only", name: "package.apk" } }] } });
    }
    assert.equal(String(url), "https://media.example/image.png");
    return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  };
  let released = 0;
  const sent: unknown[] = [];
  const provider = { acquire() { return { async call<T>(operation: string, args: any[]) {
    if (operation === "sendGroupMessage") { sent.push(args[0]); return { messageId: "505" } as T; }
    assert.equal(operation, "readReplySource");
    return await readReplySource(args[0], transport) as T;
  }, release() { released++; } }; } } as unknown as MessageEndpointEgressProvider;
  let activeProvider = provider;
  const options: AgentReplyOptions = { rootDir, routeRoot: path.join(rootDir, "routes"), rolesRoot: path.join(rootDir, "roles"),
    endpointEgress: () => activeProvider, runtimes: [{ id: "main", enabled: true, dataDir,
      messageAdapterPolicies: { napcat: { outputEnabled: true, supportedOutputs: ["text"] } },
      napcatInstances: [{ id: "qq", httpUrl: "http://localhost:1", accessToken: "", enabled: true }] }] };
  const request = { deliveryId: "file-quote", sender: { agentType: "codex", sessionId: "test-session" }, routeId: "main", channel: "napcat",
    params: { target: "group", groupId: "202", instanceId: "qq", replyToMessageId: "101" }, payload: { type: "text", text: "received" } };
  return { request, options, calls, dataDir, sent, released: () => released,
    changeProvider: () => { activeProvider = { ...provider }; } };
}

test("the formal send validator accepts a real file source without any sent message ledger and never downloads the file", async t => {
  const f = fixture(t);
  assert.throws(() => validateAgentSendReplyImageDescriptions(f.request, f.options), /was not found/);
  const evidence = await readPlatformReplySource(prepareAgentSendRequest(f.request), f.options, () => {});
  assert.ok(evidence);
  assert.doesNotThrow(() => validateAgentSendReplyImageDescriptions(f.request, f.options, undefined, evidence));
  assert.deepEqual(f.calls, ["get_msg"]);
  assert.equal(fs.existsSync(path.join(f.dataDir, "napcat-media")), false);
  assert.equal(f.released(), 1);
  for (const [field, value] of [["routeId", "other"], ["groupId", "303"], ["instanceId", "other"], ["sourceMessageId", "404"]]) {
    assert.throws(() => validateAgentSendReplyImageDescriptions(f.request, f.options, undefined, { ...evidence, [field]: value }), /does not match/);
  }
  f.changeProvider();
  assert.throws(() => validateAgentSendReplyImageDescriptions(f.request, f.options, undefined, evidence), /provider changed/);
});

test("handleAgentSend carries the trusted file evidence through to the existing send owner", async t => {
  const f = fixture(t);
  const evidence = await readPlatformReplySource(prepareAgentSendRequest(f.request), f.options, () => {});
  const result = await handleAgentSend(f.request, f.options, undefined, evidence);
  assert.equal(result.status, "sent");
  assert.equal(result.sentMessageId, "505");
  assert.equal(f.sent.length, 1);
  assert.match(JSON.stringify(f.sent), /101/);
});

test("provider and credential changes while Markdown rendering is pending prevent every actual send", async t => {
  for (const change of ["provider", "credential"] as const) {
    const f = fixture(t);
    const evidence = await readPlatformReplySource(prepareAgentSendRequest(f.request), f.options, () => {});
    f.options.runtimes[0]!.messageAdapterPolicies!.napcat = { outputEnabled: true, supportedOutputs: ["image", "text"] };
    const pending = handleAgentSend({ ...f.request, payload: { type: "markdown", text: "# A quoted file\n\nThe package was received." } }, f.options, undefined, evidence);
    if (change === "provider") f.changeProvider();
    else f.options.runtimes[0]!.napcatInstances![0]!.accessToken = "rotated-test-credential";
    const result = await pending;
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /provider changed/);
    assert.equal(f.sent.length, 0);
  }
});

test("a platform image still needs concrete descriptions and a readable managed image", async t => {
  const f = fixture(t, true);
  const evidence = await readPlatformReplySource(prepareAgentSendRequest(f.request), f.options, () => {});
  assert.throws(() => validateAgentSendReplyImageDescriptions(f.request, f.options, undefined, evidence), /must contain 1 descriptions/);
  const described = { ...f.request, params: { ...f.request.params, replyImageDescriptions: ["截图显示完整设置页面及当前配置。"] } };
  assert.doesNotThrow(() => validateAgentSendReplyImageDescriptions(described, f.options, undefined, evidence));
  assert.throws(() => validateAgentSendReplyImageDescriptions({ ...described, params: { ...described.params, replyImageDescriptions: ["已查看"] } }, f.options, undefined, evidence), /actual image content/);
  const attachment = (evidence!.record.attachments as { path: string }[])[0]!;
  attachment.path = path.join(f.options.rootDir, "unmanaged.png");
  fs.writeFileSync(attachment.path, "unmanaged");
  assert.throws(() => validateAgentSendReplyImageDescriptions(described, f.options, undefined, evidence), /outside the managed/);
  assert.deepEqual(f.calls, ["get_msg", "image.png"]);
});

test("caller source metadata cannot become evidence and current Route changes reject the read", async t => {
  const f = fixture(t);
  const forged = { ...f.request, platformSource: { record: { segments: [] } } };
  assert.throws(() => validateAgentSendReplyImageDescriptions(forged, f.options), /unsupported fields/);
  assert.throws(() => validateAgentSendReplyImageDescriptions({ ...f.request, params: { ...f.request.params, platformSource: {} } }, f.options), /unsupported fields/);
  let checks = 0;
  await assert.rejects(readPlatformReplySource(prepareAgentSendRequest(f.request), f.options, () => {
    if (++checks > 1) throw new Error("Route changed");
  }), /Route changed/);
  assert.equal(f.released(), 1);
});
