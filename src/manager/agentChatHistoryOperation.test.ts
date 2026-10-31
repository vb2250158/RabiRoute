import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { AgentSendConversationContextGuard } from "../agentSendConversationContext.js";
import { appendMessageContextToDir } from "../messageContextStore.js";
import { createAgentChatHistoryOperation, parseAgentChatHistoryQuery, projectAgentChatHistory } from "./agentChatHistoryOperation.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";

test("executable conversation history retains target selection, saved-window bounds and media projection without sending", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "api-chat-history-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const role = path.join(directory, "roles", "role");
  for (const [target, text] of [["123", "first"], ["456", "foreign"], ["123", "second [CQ:image,file=https://private.invalid/a]"]]) {
    appendMessageContextToDir(role, { time: 100, direction: "inbound", adapter: "napcat", gatewayId: "gateway", kind: "group",
      target, text, messageId: text.slice(0, 6) }, { archiveCheck: false });
  }
  const guard = new AgentSendConversationContextGuard();
  const registry = new ManagerPluginRouteRegistry();
  let revoked = false;
  let revokeOnRead = false;
  const registration = registry.registerOperations("chat-history", [createAgentChatHistoryOperation({ readChatHistory: async url => {
    const { send, query } = parseAgentChatHistoryQuery(url);
    const result = await guard.searchHistory(send, { rootDir: directory, rolesRoot: "roles", routeRoot: path.join(directory, "routes"),
      runtimes: [{ id: "gateway", agentRoleId: "role", routeProfiles: [{ id: "route" }] }] }, query);
    if (revokeOnRead) revoked = true;
    return projectAgentChatHistory(result);
  } })]);
  const server = http.createServer((request, response) => {
    markAuthenticatedConnectionRequest(request, () => { if (revoked) throw new Error("Revoked fixture connection"); });
    if (!registry.handle(request, new URL(request.url!, "http://localhost"), response)) response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await registration.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const query = new URLSearchParams({ routeId: "route", channel: "napcat", params: JSON.stringify({ target: "group", groupId: "123", replyToMessageId: "" }), afterSequence: "0" });
  const base = `http://127.0.0.1:${address.port}/api/agent/chat-history?${query}`;
  const response = await fetch(base); const body = await response.text(); assert.equal(response.status, 200, body);
  assert.ok(!body.includes("private.invalid") && !body.includes("foreign"));
  const window = JSON.parse(body).data;
  assert.deepEqual(window.entries.map((row: { text: string }) => row.text), ["first", "second [image]"]);
  assert.equal(window.totalCount, 2); assert.equal(window.omittedCount, 0);
  const filtered = await fetch(base + "&query=second"); assert.equal(filtered.status, 200);
  assert.equal((await filtered.json()).data.entries.length, 1);
  assert.equal((await fetch(base + "&beforeSequence=-1")).status, 400);
  assert.equal((await fetch(base + "&params=duplicated")).status, 400);
  assert.equal((await fetch(base + "&targetUrl=https://example.invalid")).status, 400);
  revokeOnRead = true;
  const stopped = await fetch(base); assert.equal(stopped.status, 403);
  assert.equal((await stopped.json()).errorCode, "API_REQUEST_AUTHORITY_REVOKED");
});
