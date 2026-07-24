import assert from "node:assert/strict";
import test from "node:test";
import { personaVoiceIdentityClient } from "../src/persona/personaVoiceIdentityClient";

test("persona voice UI requests summary-only evidence and sends explicit persona decisions", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    requests.push({ url, init });
    const data = url.includes("voice-transcripts")
      ? {
          identityPath: "voice/voice-identities.jsonl",
          conversationPath: "conversation/current.jsonl",
          matchedCount: 0,
          items: [],
          summary: {
            recordCount: 0,
            mixedRecordCount: 0,
            segmentCount: 0,
            recordingDurationSeconds: 0,
            speakerDurationSeconds: 0,
            classifiedSpeakerDurationSeconds: 0,
            coverageRate: 0,
            byClassification: {
              user: { records: 0, segments: 0, speakerDurationSeconds: 0 },
              other: { records: 0, segments: 0, speakerDurationSeconds: 0 },
              unknown: { records: 0, segments: 0, speakerDurationSeconds: 0 },
              conflict: { records: 0, segments: 0, speakerDurationSeconds: 0 }
            },
            unresolvedVoiceprints: []
          }
        }
      : url.includes("voice-identities") && init.method === "PUT"
        ? { appended: true, deleted: false }
        : { path: "voice/voice-identities.jsonl", identities: [] };
    return new Response(JSON.stringify({ code: 0, data }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    await personaVoiceIdentityClient.summary("Rabi A", "2026-07-23T00:00:00.000Z", "2026-07-24T00:00:00.000Z");
    await personaVoiceIdentityClient.identities("Rabi A");
    await personaVoiceIdentityClient.update("Rabi A", {
      sourceHostId: "host-one",
      sourceHostName: "Studio PC",
      voiceprintId: "voiceprint-one",
      isUser: null
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const summaryUrl = new URL(requests[0]!.url, "http://127.0.0.1");
  assert.equal(summaryUrl.pathname, "/api/roles/Rabi%20A/voice-transcripts");
  assert.equal(summaryUrl.searchParams.get("from"), "2026-07-23T00:00:00.000Z");
  assert.equal(summaryUrl.searchParams.get("to"), "2026-07-24T00:00:00.000Z");
  assert.equal(summaryUrl.searchParams.get("includeArchives"), "true");
  assert.equal(summaryUrl.searchParams.get("includeDetails"), "false");
  assert.equal(requests[1]!.url, "/api/roles/Rabi%20A/voice-identities");
  assert.equal(requests[2]!.url, "/api/roles/Rabi%20A/voice-identities");
  assert.equal(requests[2]!.init.method, "PUT");
  assert.deepEqual(JSON.parse(String(requests[2]!.init.body)), {
    sourceHostId: "host-one",
    sourceHostName: "Studio PC",
    voiceprintId: "voiceprint-one",
    isUser: null
  });
});
