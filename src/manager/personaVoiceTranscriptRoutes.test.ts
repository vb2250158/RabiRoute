import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendMessageContextToDir } from "../messageContextStore.js";
import { updatePersonaVoiceIdentity } from "../personaVoiceIdentities.js";
import { handlePersonaVoiceTranscriptApi } from "./personaVoiceTranscriptRoutes.js";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Missing test server port."));
      resolve(address.port);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode || 0,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.on("error", reject);
  });
}

test("persona voice transcript API filters the persona's explicit user evidence", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-voice-api-"));
  const roleDir = path.join(root, "Rabi");
  updatePersonaVoiceIdentity(roleDir, {
    sourceHostId: "host-one",
    voiceprintId: "cluster-user",
    displayName: "老板",
    isUser: true,
    aliases: []
  });
  appendMessageContextToDir(roleDir, {
    time: Date.UTC(2026, 6, 23, 9, 0, 0) / 1_000,
    direction: "inbound",
    adapter: "speech",
    kind: "asr",
    sourceHostId: "host-one",
    messageId: "voice-user",
    text: "继续完善。",
    segments: [{ id: 0, start: 0, end: 1, text: "继续完善。", speakerClusterId: "cluster-user" }]
  }, { archiveCheck: false });
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    if (!handlePersonaVoiceTranscriptApi(request, requestUrl, response, {
      roleDir: roleId => path.join(root, roleId)
    })) response.writeHead(404).end();
  });
  const port = await listen(server);
  t.after(() => close(server));

  const response = await get(`http://127.0.0.1:${port}/api/roles/Rabi/voice-transcripts?speaker=user`);
  assert.equal(response.status, 200);
  const body = JSON.parse(response.body) as { data: { identityPath: string; matchedCount: number; summary: { coverageRate: number }; items: Array<Record<string, unknown>> } };
  assert.equal(body.data.identityPath, "voice/voice-identities.jsonl");
  assert.equal(body.data.matchedCount, 1);
  assert.equal(body.data.summary.coverageRate, 1);
  assert.equal(body.data.items.length, 1);
  assert.equal(body.data.items[0]?.personaClassification, "user");

  const summaryOnly = await get(`http://127.0.0.1:${port}/api/roles/Rabi/voice-transcripts?includeArchives=true&includeDetails=false`);
  assert.equal(summaryOnly.status, 200);
  const summaryOnlyBody = JSON.parse(summaryOnly.body) as { data: { matchedCount: number; summary: { coverageRate: number }; items: unknown[] } };
  assert.equal(summaryOnlyBody.data.matchedCount, 1);
  assert.equal(summaryOnlyBody.data.summary.coverageRate, 1);
  assert.deepEqual(summaryOnlyBody.data.items, []);

  const invalid = await get(`http://127.0.0.1:${port}/api/roles/Rabi/voice-transcripts?speaker=host-guessed`);
  assert.equal(invalid.status, 400);
  assert.match(invalid.body, /user, other, unknown, or conflict/);
});
