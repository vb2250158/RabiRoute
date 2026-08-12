import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  handleManagerEventApi,
  handleManagerPersonaDomainApi
} from "./controlPlaneRoutes.js";
import { updateIdentityRelation } from "../identityRelations.js";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Missing test Manager port."));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

async function waitForManagerEvent<T>(
  baseUrl: string,
  eventType: string,
  action: () => Promise<void>
): Promise<T> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new Error(`Manager event timed out: ${eventType}`)), 5_000);
  try {
    const response = await fetch(`${baseUrl}/api/events`, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal
    });
    assert.equal(response.status, 200);
    assert.ok(response.body);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let actionPromise: Promise<void> | undefined;
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error(`Manager event stream closed before ${eventType}.`);
      buffer += decoder.decode(value, { stream: true }).replace(/\r/g, "");
      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) break;
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const type = frame.split("\n").find(line => line.startsWith("event:"))?.slice(6).trim() || "message";
        const data = frame.split("\n").find(line => line.startsWith("data:"))?.slice(5).trim() || "{}";
        if (type === "ready" && !actionPromise) actionPromise = action();
        if (type === eventType) {
          await actionPromise;
          return JSON.parse(data) as T;
        }
      }
    }
  } finally {
    clearTimeout(deadline);
    controller.abort();
  }
}

test("Manager persona-domain HTTP route accepts voice identity PUT and publishes its SSE event", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-manager-voice-identity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    if (handleManagerEventApi(request, requestUrl, response)) return;
    if (handleManagerPersonaDomainApi(request, requestUrl, response, {
      rolesRoot: root,
      roleDir: roleId => path.join(root, roleId)
    })) return;
    response.writeHead(404).end();
  });
  const port = await listen(server);
  t.after(() => close(server));

  const baseUrl = `http://127.0.0.1:${port}`;
  const roleId = "Rabi-A";
  const rolePath = encodeURIComponent(roleId);
  updateIdentityRelation(path.join(root, roleId), {
    kind: "participant",
    participantId: "participant-owner",
    participantKind: "person",
    displayName: "Current user",
    status: "confirmed"
  });

  const invalidParticipantResponse = await fetch(`${baseUrl}/api/roles/${rolePath}/voice-identities`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourceHostId: "host-one",
      voiceprintId: "voiceprint-invalid",
      participantId: "missing-participant"
    })
  });
  assert.equal(invalidParticipantResponse.status, 400);
  assert.match(String((await invalidParticipantResponse.json() as Record<string, unknown>).message), /confirmed identity/);

  const invalidParticipantTypeResponse = await fetch(`${baseUrl}/api/roles/${rolePath}/voice-identities`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourceHostId: "host-one",
      voiceprintId: "voiceprint-invalid-type",
      participantId: 42
    })
  });
  assert.equal(invalidParticipantTypeResponse.status, 400);
  assert.match(String((await invalidParticipantTypeResponse.json() as Record<string, unknown>).message), /string, null, or omitted/);

  let putStatus = 0;
  let putBody: Record<string, any> = {};
  const event = await waitForManagerEvent<{ roleId: string; appended: boolean; deleted: boolean }>(
    baseUrl,
    "persona_voice_identity_changed",
    async () => {
      const response = await fetch(`${baseUrl}/api/roles/${rolePath}/voice-identities`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceHostId: "host-one",
          sourceHostName: "Workstation",
          voiceprintId: "voiceprint-one",
          participantId: "participant-owner",
          displayName: "Current user",
          relationship: "self",
          isUser: true,
          aliases: []
        })
      });
      putStatus = response.status;
      putBody = await response.json() as Record<string, any>;
    }
  );

  assert.equal(putStatus, 201);
  assert.equal(putBody.code, 0);
  assert.equal(putBody.data.appended, true);
  assert.equal(putBody.data.identity.isUser, true);
  assert.equal(putBody.data.identity.participantId, "participant-owner");
  assert.deepEqual(event, { roleId, appended: true, deleted: false });

  const listResponse = await fetch(`${baseUrl}/api/roles/${rolePath}/voice-identities`);
  assert.equal(listResponse.status, 200);
  const listBody = await listResponse.json() as Record<string, any>;
  assert.equal(listBody.data.path, "voice/voice-identities.jsonl");
  assert.equal(listBody.data.identities.length, 1);
  assert.equal(listBody.data.identities[0].sourceHostId, "host-one");
  assert.equal(listBody.data.identities[0].voiceprintId, "voiceprint-one");
  assert.equal(listBody.data.identities[0].participantId, "participant-owner");
  assert.equal(listBody.data.identities[0].isUser, true);

  const identityRelationsResponse = await fetch(`${baseUrl}/api/roles/${rolePath}/identity-relations`);
  assert.equal(identityRelationsResponse.status, 200);
  const identityRelationsBody = await identityRelationsResponse.json() as Record<string, any>;
  const voiceAccount = identityRelationsBody.data.endpointAccounts.find((item: Record<string, any>) =>
    item.platform === "voice"
    && item.endpointIdentityNamespace === "host:host-one"
    && item.senderStableId === "voiceprint-one"
  );
  assert.ok(voiceAccount);
  assert.deepEqual(voiceAccount.participantLinks.map((link: Record<string, any>) => ({
    participantId: link.participantId,
    status: link.status
  })), [{ participantId: "participant-owner", status: "confirmed" }]);

  const filePath = path.join(root, roleId, "voice", "voice-identities.jsonl");
  const persisted = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line) as Record<string, unknown>);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]?.sourceHostId, "host-one");
  assert.equal(persisted[0]?.voiceprintId, "voiceprint-one");
  assert.equal(persisted[0]?.participantId, "participant-owner");
  assert.equal(persisted[0]?.isUser, true);

  const unlinkResponse = await fetch(`${baseUrl}/api/roles/${rolePath}/voice-identities`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourceHostId: "host-one",
      voiceprintId: "voiceprint-one",
      participantId: null
    })
  });
  assert.equal(unlinkResponse.status, 201);

  const afterUnlinkResponse = await fetch(`${baseUrl}/api/roles/${rolePath}/identity-relations`);
  assert.equal(afterUnlinkResponse.status, 200);
  const afterUnlinkBody = await afterUnlinkResponse.json() as Record<string, any>;
  const unlinkedVoiceAccount = afterUnlinkBody.data.endpointAccounts.find((item: Record<string, any>) =>
    item.platform === "voice"
    && item.endpointIdentityNamespace === "host:host-one"
    && item.senderStableId === "voiceprint-one"
  );
  assert.ok(unlinkedVoiceAccount);
  assert.deepEqual(unlinkedVoiceAccount.participantLinks.map((link: Record<string, any>) => link.status), ["retired"]);
});
