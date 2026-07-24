import assert from "node:assert/strict";
import test from "node:test";
import { collectBuiltManagerReadOnlySummary } from "./test-built-manager-readonly.mjs";

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

test("built Manager read-only summary keeps private persona data out of evidence", async () => {
  const fetchImpl = async url => {
    const request = new URL(url);
    if (request.pathname === "/gateways") {
      return jsonResponse({ data: { manager: [{ id: "private-route", name: "Private Route" }] } });
    }
    if (request.pathname === "/api/persona-sync/manifest") {
      return jsonResponse({ data: { roles: [{ roleId: "private-persona", files: [{ path: "persona.md" }, { path: "secret.md" }] }] } });
    }
    if (request.pathname === "/api/persona-sync/conflicts") {
      return jsonResponse({ data: { conflicts: [{ roleId: "private-persona", path: "secret.md" }] } });
    }
    if (request.pathname === "/api/persona-sync/index-status") {
      return jsonResponse({ data: { state: "ready", watchMode: "disabled", files: 2 } });
    }
    if (request.pathname === "/api/speech/messages") {
      return jsonResponse({ data: { records: [{ text: "private transcript" }] } });
    }
    if (request.pathname.endsWith("/voice-identities")) {
      return jsonResponse({ data: { identities: [{ displayName: "private person", isUser: true }] } });
    }
    if (request.pathname.endsWith("/voice-transcripts")) {
      return jsonResponse({ data: { matchedCount: 4, items: [{ record: { text: "private persona transcript" } }] } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const summary = await collectBuiltManagerReadOnlySummary("http://127.0.0.1:45678", fetchImpl);
  assert.deepEqual(summary.counts, {
    gateways: 1,
    personas: 1,
    personasProbed: 1,
    personaFiles: 2,
    personaManifestIndexFiles: 2,
    personaSyncConflicts: 1,
    returnedSpeechMessages: 1,
    personaVoiceIdentities: 1,
    matchedPersonaVoiceTranscripts: 4,
    returnedPersonaVoiceTranscripts: 1
  });
  assert.equal(summary.checks.every(check => check.passed), true);
  const serialized = JSON.stringify(summary);
  for (const privateValue of [
    "private-route",
    "Private Route",
    "private-persona",
    "secret.md",
    "private transcript",
    "private person",
    "private persona transcript"
  ]) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

test("built Manager read-only summary fails persona-scoped coverage when no persona exists", async () => {
  const fetchImpl = async url => {
    const request = new URL(url);
    if (request.pathname === "/gateways") return jsonResponse({ data: { manager: [] } });
    if (request.pathname === "/api/persona-sync/manifest") return jsonResponse({ data: { roles: [] } });
    if (request.pathname === "/api/persona-sync/conflicts") return jsonResponse({ data: { conflicts: [] } });
    if (request.pathname === "/api/persona-sync/index-status") return jsonResponse({ data: { state: "ready", watchMode: "disabled", files: 0 } });
    if (request.pathname === "/api/speech/messages") return jsonResponse({ data: { records: [] } });
    throw new Error(`Unexpected URL: ${url}`);
  };

  const summary = await collectBuiltManagerReadOnlySummary("http://127.0.0.1:45678", fetchImpl);
  const personaCheck = summary.checks.find(check => check.id === "persona_scoped_read_boundaries");
  assert.equal(personaCheck?.passed, false);
  assert.equal(personaCheck?.reason, "no_persona_available");
  assert.equal(summary.counts.personasProbed, 0);
});

test("built Manager read-only failures redact the persona id from boundary errors", async () => {
  const fetchImpl = async url => {
    const request = new URL(url);
    if (request.pathname === "/gateways") return jsonResponse({ data: { manager: [] } });
    if (request.pathname === "/api/persona-sync/manifest") {
      return jsonResponse({ data: { roles: [{ roleId: "private-persona", files: [] }] } });
    }
    if (request.pathname === "/api/persona-sync/conflicts") return jsonResponse({ data: { conflicts: [] } });
    if (request.pathname === "/api/persona-sync/index-status") return jsonResponse({ data: { state: "ready", watchMode: "disabled", files: 0 } });
    if (request.pathname === "/api/speech/messages") return jsonResponse({ data: { records: [] } });
    throw new Error("one-shot timeout");
  };

  await assert.rejects(
    () => collectBuiltManagerReadOnlySummary("http://127.0.0.1:45678", fetchImpl),
    error => {
      assert.match(error.message, /persona_voice_/);
      assert.equal(error.message.includes("private-persona"), false);
      return true;
    }
  );
});
