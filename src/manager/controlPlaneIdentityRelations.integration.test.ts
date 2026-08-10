import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { recordConversationSituation } from "../conversationSituationStore.js";
import { conversationSituationForIdentity } from "../routing/conversationSituation.js";
import { handleManagerPersonaDomainApi } from "./controlPlaneRoutes.js";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Missing test Manager port."));
      resolve(address.port);
    });
  });
}

test("Manager identity-relation API stores a confirmed endpoint mapping and resolves it by exact account key", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-manager-identity-relations-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    if (handleManagerPersonaDomainApi(request, requestUrl, response, { rolesRoot: root, roleDir: roleId => path.join(root, roleId) })) return;
    response.writeHead(404).end();
  });
  const port = await listen(server);
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const baseUrl = `http://127.0.0.1:${port}`;
  const endpoint = `${baseUrl}/api/roles/Xinghai/identity-relations`;
  const put = async (body: Record<string, unknown>) => {
    const response = await fetch(endpoint, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 201);
    return await response.json() as Record<string, any>;
  };
  await put({ kind: "participant", participantId: "participant-cotton", participantKind: "person", displayName: "COTTON", status: "confirmed", aliases: [], evidenceRefs: [{ messageId: "m-confirm" }] });
  await put({ kind: "endpoint_account", platform: "napcat", endpointIdentityNamespace: "instance:qq-main", senderStableId: "200", participantLinks: [{ participantId: "participant-cotton", status: "confirmed", confidence: 1, evidenceRefs: [{ messageId: "m-confirm" }] }] });

  const response = await fetch(`${endpoint}?platform=napcat&endpointIdentityNamespace=instance%3Aqq-main&senderStableId=200&conversationKey=napcat%3Agroup%3A100`);
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, any>;
  assert.equal(body.code, 0);
  assert.equal(body.data.path, "identity-relations/events.jsonl");
  assert.equal(body.data.context.confirmedParticipant.displayName, "COTTON");
  assert.equal(body.data.context.endpoint.senderStableId, "200");
});

test("Manager returns persisted conversation-situation shadow assessments for the persona page", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-manager-conversation-situations-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  recordConversationSituation(path.join(root, "Xinghai"), "route-xinghai", "group_message", conversationSituationForIdentity(undefined, {
    conversationId: "napcat:instance:qq-main:group:b4f8", messageIds: ["message-1"], routeKind: "group_message"
  }));
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    if (handleManagerPersonaDomainApi(request, requestUrl, response, { rolesRoot: root, roleDir: roleId => path.join(root, roleId) })) return;
    response.writeHead(404).end();
  });
  const port = await listen(server);
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const response = await fetch(`http://127.0.0.1:${port}/api/roles/Xinghai/conversation-situations?limit=10`);
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, any>;
  assert.equal(body.code, 0);
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].conversationId, "napcat:instance:qq-main:group:b4f8");
  assert.equal(body.data[0].decisions.mayCreateOrUpdateCurrentProjectRecords, false);
});
