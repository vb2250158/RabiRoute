import assert from "node:assert/strict";
import test from "node:test";
import { collectBuiltManagerReadOnlySummary } from "./test-built-manager-readonly.mjs";

test("built Manager read-only summary rejects unhealthy or mismatched READY identity before business reads", async () => {
  for (const meta of [
    { health: { state: "starting", requiredReady: false } },
    { health: { state: "healthy", requiredReady: true }, applicationGenerationId: "other", managerInstanceId: "other" }
  ]) {
    const requests = [];
    await assert.rejects(() => collectBuiltManagerReadOnlySummary("http://127.0.0.1:45678", async url => {
      requests.push(new URL(url).pathname);
      return jsonResponse(meta);
    }, { applicationGenerationId: "expected", managerInstanceId: "expected" }), /READY identity changed/);
    assert.deepEqual(requests, ["/meta"]);
  }
});

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

test("built Manager read-only summary keeps private persona data out of evidence", async () => {
  const fetchImpl = async url => {
    const request = new URL(url);
    if (request.pathname === "/meta") return jsonResponse({
      health: { state: "healthy", requiredReady: true },
      applicationGenerationId: "fixture-generation", managerInstanceId: "fixture-manager"
    });
    if (request.pathname === "/gateways") {
      return jsonResponse({ data: { manager: [{ id: "private-route", name: "Private Route" }] } });
    }
    if (request.pathname === "/api/personas") {
      return jsonResponse({ personas: [{ personaId: "private-persona", name: "Private Persona" }] });
    }
    if (request.pathname === "/api/speech/messages") {
      return jsonResponse({ data: { records: [{ text: "private transcript" }] } });
    }
    if (request.pathname === "/api/scan/message-adapters") {
      return jsonResponse({
        adapters: { napcat: {}, weixin: {} },
        repair: { changed: false, messages: [] },
        scan: { partial: false, durationMs: 42 }
      });
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
    returnedSpeechMessages: 1,
    scannedMessageAdapters: 2,
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
    if (request.pathname === "/meta") return jsonResponse({
      health: { state: "healthy", requiredReady: true },
      applicationGenerationId: "fixture-generation", managerInstanceId: "fixture-manager"
    });
    if (request.pathname === "/gateways") return jsonResponse({ data: { manager: [] } });
    if (request.pathname === "/api/personas") return jsonResponse({ personas: [] });
    if (request.pathname === "/api/speech/messages") return jsonResponse({ data: { records: [] } });
    if (request.pathname === "/api/scan/message-adapters") {
      return jsonResponse({
        adapters: { napcat: {} },
        repair: { changed: false, messages: [] },
        scan: { partial: true, durationMs: 6500 }
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const summary = await collectBuiltManagerReadOnlySummary("http://127.0.0.1:45678", fetchImpl);
  const personaCheck = summary.checks.find(check => check.id === "persona_scoped_read_boundaries");
  assert.equal(personaCheck?.passed, false);
  assert.equal(personaCheck?.reason, "no_persona_available");
  assert.equal(summary.counts.personasProbed, 0);
});

test("built Manager read-only summary retries while the initial route catalog is still loading", async () => {
  let gatewayAttempts = 0;
  const fetchImpl = async url => {
    const request = new URL(url);
    if (request.pathname === "/meta") return jsonResponse({
      health: { state: "healthy", requiredReady: true },
      applicationGenerationId: "fixture-generation", managerInstanceId: "fixture-manager"
    });
    if (request.pathname === "/gateways") {
      gatewayAttempts += 1;
      if (gatewayAttempts === 1) {
        return new Response(JSON.stringify({
          message: "The initial route catalog snapshot is not installed. Retry after startup recovery completes."
        }), {
          status: 503,
          headers: { "content-type": "application/json" }
        });
      }
      return jsonResponse({ data: { manager: [] } });
    }
    assert.equal(gatewayAttempts, 2, "persona reads must wait for the route catalog readiness barrier");
    if (request.pathname === "/api/personas") return jsonResponse({ personas: [] });
    if (request.pathname === "/api/speech/messages") return jsonResponse({ data: { records: [] } });
    if (request.pathname === "/api/scan/message-adapters") {
      return jsonResponse({
        adapters: { napcat: {} },
        repair: { changed: false, messages: [] },
        scan: { partial: false, durationMs: 12 }
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  await collectBuiltManagerReadOnlySummary("http://127.0.0.1:45678", fetchImpl);
  assert.equal(gatewayAttempts, 2);
});

test("built Manager read-only failures redact the persona id from boundary errors", async () => {
  const fetchImpl = async url => {
    const request = new URL(url);
    if (request.pathname === "/meta") return jsonResponse({
      health: { state: "healthy", requiredReady: true },
      applicationGenerationId: "fixture-generation", managerInstanceId: "fixture-manager"
    });
    if (request.pathname === "/gateways") return jsonResponse({ data: { manager: [] } });
    if (request.pathname === "/api/personas") {
      return jsonResponse({ personas: [{ personaId: "private-persona" }] });
    }
    if (request.pathname === "/api/speech/messages") return jsonResponse({ data: { records: [] } });
    if (request.pathname === "/api/scan/message-adapters") {
      return jsonResponse({
        adapters: { napcat: {} },
        repair: { changed: false, messages: [] },
        scan: { partial: false, durationMs: 12 }
      });
    }
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
