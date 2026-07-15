import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const rabiRouteRoot = path.resolve(projectRoot, "..", "..");
const relayBaseUrl = String(process.env.RABILINK_E2E_RELAY_URL || "").trim().replace(/\/+$/, "");
const token = String(process.env.RABILINK_E2E_TOKEN || "").trim();
const managerBaseUrl = String(process.env.RABILINK_E2E_MANAGER_URL || "http://127.0.0.1:8790").trim().replace(/\/+$/, "");
const configOnly = process.argv.includes("--config-only");
const defaultReportName = configOnly ? "config-rollback-e2e.json" : "live-relay-codex.json";
const reportPath = path.resolve(process.env.RABILINK_E2E_REPORT || path.join(projectRoot, "dist", defaultReportName));
const aixPath = path.join(projectRoot, "dist", "rabilink-aiui.aix");
const craftReleasePath = path.join(projectRoot, "craft-release.json");
const replyTimeoutMs = Math.max(30000, Number(process.env.RABILINK_E2E_REPLY_TIMEOUT_MS || 8 * 60 * 1000));
const releaseTimeoutMs = Math.max(5000, Number(process.env.RABILINK_E2E_RELEASE_TIMEOUT_MS || 30000));
const duplicateGraceMs = Math.max(1000, Number(process.env.RABILINK_E2E_DUPLICATE_GRACE_MS || 8000));

assert.ok(relayBaseUrl, "RABILINK_E2E_RELAY_URL is required.");
assert.ok(token, "RABILINK_E2E_TOKEN is required.");

const relayHeaders = {
  "content-type": "application/json",
  "x-rabilink-token": token
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nonce(prefix) {
  return `${prefix}_${new Date().toISOString().replace(/[-:.TZ]/g, "")}_${crypto.randomBytes(3).toString("hex")}`;
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex").slice(0, 16);
}

function fileSha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

const implementationFiles = JSON.parse(fs.readFileSync(
  path.join(import.meta.dirname, "active-intelligence-implementation-files.json"),
  "utf8"
));
assert.ok(Array.isArray(implementationFiles) && implementationFiles.length > 0,
  "Active-intelligence implementation manifest must contain at least one file.");
assert.equal(new Set(implementationFiles).size, implementationFiles.length,
  "Active-intelligence implementation manifest must not contain duplicate files.");

function implementationDigest() {
  const hash = crypto.createHash("sha256");
  for (const relativePath of implementationFiles) {
    assert.equal(typeof relativePath, "string", "Implementation manifest entries must be strings.");
    const normalized = relativePath.replaceAll("\\", "/");
    const filePath = path.join(rabiRouteRoot, ...normalized.split("/"));
    hash.update(normalized, "utf8");
    hash.update("\0", "utf8");
    hash.update(fs.readFileSync(filePath));
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

function currentBuildEvidence() {
  const release = JSON.parse(fs.readFileSync(craftReleasePath, "utf8"));
  return {
    release_version: String(release?.version || ""),
    aix_sha256: fileSha256(aixPath),
    implementation_digest: implementationDigest()
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function configDigest(value) {
  return digest(canonicalJson(value));
}

function ledgerSearchRoots() {
  const explicit = String(process.env.RABILINK_E2E_LEDGER_DIR || "").trim();
  return explicit
    ? [path.resolve(explicit)]
    : [path.join(rabiRouteRoot, "data"), path.join(rabiRouteRoot, "examples", "data")];
}

function findConversationLedgers(root) {
  if (!fs.existsSync(root)) return [];
  const found = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      if (item.isDirectory()) {
        if (!["node_modules", "dist", ".git", "rabilink-conversations"].includes(item.name)) {
          pending.push(path.join(current, item.name));
        }
        continue;
      }
      if (item.isFile() && item.name === "rabilink-conversation.jsonl") {
        found.push(path.join(current, item.name));
      }
    }
  }
  return found;
}

function ledgerEntryForMarker(marker, direction) {
  for (const root of ledgerSearchRoots()) {
    for (const file of findConversationLedgers(root)) {
      const rows = fs.readFileSync(file, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
      const row = rows.find((entry) => {
        return String(entry?.direction || "") === direction
          && String(entry?.text || "").includes(marker);
      });
      if (row) return { file, row };
    }
  }
  return null;
}

async function waitForLedgerMarker(marker, direction, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = ledgerEntryForMarker(marker, direction);
    if (found) return found;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${direction} marker in the unified conversation ledger.`);
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, init);
  const raw = await response.text();
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = { message: raw };
  }
  if (!response.ok) {
    throw new Error(String(body?.message || body?.error || `${response.status} ${response.statusText}`));
  }
  return { response, body };
}

async function relayGet(pathname) {
  return fetchJson(`${relayBaseUrl}${pathname}`, { headers: relayHeaders });
}

async function relayPost(pathname, body) {
  return fetchJson(`${relayBaseUrl}${pathname}`, {
    method: "POST",
    headers: relayHeaders,
    body: JSON.stringify(body)
  });
}

async function streamTail() {
  const { body } = await relayGet("/rokid/rabilink/messages?stream=1&tail=1&waitMs=0");
  return String(body?.nextCursor || body?.cursor || "");
}

async function pollStreamForMarker(after, marker, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let cursor = String(after || "");
  const observed = [];
  while (Date.now() < deadline) {
    const waitMs = Math.min(30000, Math.max(0, deadline - Date.now()));
    const query = new URLSearchParams({ stream: "1", after: cursor, waitMs: String(waitMs) });
    const { body } = await relayGet(`/rokid/rabilink/messages?${query}`);
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    observed.push(...messages);
    cursor = String(body?.nextCursor || body?.cursor || cursor);
    const match = messages.find((message) => String(message?.text || "").includes(marker));
    if (match) return { match, cursor, observed, receivedAt: Date.now() };
  }
  throw new Error("Timed out waiting for the expected RabiLink outbound marker.");
}

async function collectMarkerDuplicates(after, marker, durationMs) {
  const deadline = Date.now() + durationMs;
  let cursor = String(after || "");
  const matches = [];
  while (Date.now() < deadline) {
    const waitMs = Math.min(2000, Math.max(0, deadline - Date.now()));
    const query = new URLSearchParams({ stream: "1", after: cursor, waitMs: String(waitMs) });
    const { body } = await relayGet(`/rokid/rabilink/messages?${query}`);
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    matches.push(...messages.filter((message) => String(message?.text || "").includes(marker)));
    cursor = String(body?.nextCursor || body?.cursor || cursor);
  }
  return matches;
}

async function waitForUpstreamRelease(taskId, timeoutMs) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let lastStatus = "";
  while (Date.now() < deadline) {
    const { body } = await relayGet(`/rokid/rabilink/tasks/${encodeURIComponent(taskId)}`);
    lastStatus = String(body?.status || "");
    if (["done", "failed"].includes(lastStatus)) {
      return { status: lastStatus, releasedAt: Date.now(), releaseMs: Date.now() - startedAt };
    }
    await sleep(200);
  }
  throw new Error(`Upstream Relay task did not release in time; last status=${lastStatus || "unknown"}.`);
}

async function postAgentReply(body) {
  return fetchJson(`${managerBaseUrl}/api/agent/replies`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function mobileWebguiGet(pathname) {
  const query = new URLSearchParams({ path: pathname });
  const { body } = await relayGet(`/api/rabilink/mobile/webgui?${query}`);
  return body;
}

async function mobileWebguiWrite(pathname, body, method = "POST") {
  const result = await relayPost("/api/rabilink/mobile/webgui", {
    method,
    path: pathname,
    body
  });
  assert.equal(result.body?.code, 0, `Remote PC configuration write failed for ${pathname}.`);
  return result.body;
}

function gatewaysFromPayload(payload) {
  const gateways = payload?.data?.config?.gateways;
  assert.ok(Array.isArray(gateways), "Remote PC WebGUI must return the editable gateway configuration list.");
  return gateways;
}

async function waitForGatewayConfig(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastGateways = [];
  while (Date.now() < deadline) {
    lastGateways = gatewaysFromPayload(await mobileWebguiGet("/gateways"));
    if (predicate(lastGateways)) return lastGateways;
    await sleep(250);
  }
  return lastGateways;
}

async function testRemoteConfigurationRollback() {
  console.log("[e2e] Testing remote Rabi configuration write and exact rollback...");
  const originalGateways = structuredClone(gatewaysFromPayload(await mobileWebguiGet("/gateways")));
  const routeIndex = originalGateways.findIndex((gateway) => String(gateway?.id || gateway?.configName || "") === "RabiLink");
  assert.ok(routeIndex >= 0, "The remote Rabi configuration must contain the RabiLink route.");
  const originalConfigDigest = configDigest(originalGateways);
  const testKey = "__rabilinkActiveIntelligenceE2E";
  const testValue = nonce("config");
  const patchedGateways = structuredClone(originalGateways);
  patchedGateways[routeIndex].routeVariables = {
    ...(patchedGateways[routeIndex].routeVariables || {}),
    [testKey]: testValue
  };
  let temporaryPatchObserved = false;
  let restoredConfigDigest = "";
  try {
    await mobileWebguiWrite("/gateways", { gateways: patchedGateways });
    const patchedReadback = await waitForGatewayConfig((gateways) => {
      const route = gateways.find((gateway) => String(gateway?.id || gateway?.configName || "") === "RabiLink");
      return route?.routeVariables?.[testKey] === testValue;
    });
    const patchedRoute = patchedReadback.find((gateway) => String(gateway?.id || gateway?.configName || "") === "RabiLink");
    temporaryPatchObserved = patchedRoute?.routeVariables?.[testKey] === testValue;
    assert.equal(temporaryPatchObserved, true, "The temporary route variable must be readable through the same remote configuration path.");
  } finally {
    await mobileWebguiWrite("/gateways", { gateways: originalGateways });
    const restoredGateways = await waitForGatewayConfig((gateways) => configDigest(gateways) === originalConfigDigest);
    restoredConfigDigest = configDigest(restoredGateways);
    assert.equal(restoredConfigDigest, originalConfigDigest, "Remote Rabi configuration must match its pre-test state after rollback.");
  }
  return {
    readThroughRelay: true,
    writeThroughRelay: true,
    temporaryPatchObserved,
    rollbackVerified: restoredConfigDigest === originalConfigDigest,
    originalConfigDigest,
    restoredConfigDigest,
    sensitiveConfigStored: false
  };
}

async function main() {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });

  if (configOnly) {
    const configuration = await testRemoteConfigurationRollback();
    fs.writeFileSync(reportPath, `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      ok: true,
      build: currentBuildEvidence(),
      configuration,
      security: {
        tokenStored: false,
        relayUrlStored: false,
        managerUrlStored: false,
        rawConversationStored: false
      }
    }, null, 2)}\n`, "utf8");
    console.log(`[e2e] Remote Rabi configuration rollback passed; report=${reportPath}`);
    return;
  }

  console.log("[e2e] Testing taskless proactive delivery through the Rabi output gate...");
  const proactiveMarker = nonce("RABILINK_PROACTIVE_E2E");
  const proactiveCursor = await streamTail();
  const proactivePostedAt = Date.now();
  const proactiveGate = await postAgentReply({
    text: proactiveMarker,
    routeProfileId: "RabiLink",
    targetType: "rabilink",
    proactive: true,
    source: "Codex active intelligence E2E"
  });
  assert.equal(proactiveGate.body?.ok, true, "The Rabi output gate must accept proactive delivery.");
  assert.equal(proactiveGate.body?.status, "sent", "The Rabi output gate must report proactive delivery as sent.");
  const proactiveDelivery = await pollStreamForMarker(proactiveCursor, proactiveMarker, 30000);
  const proactiveDuplicates = await collectMarkerDuplicates(proactiveDelivery.cursor, proactiveMarker, duplicateGraceMs);
  assert.equal(proactiveDelivery.match?.proactive, true, "Taskless output must be marked proactive.");
  assert.equal(proactiveDelivery.match?.final, true, "Taskless proactive output must be final.");
  assert.equal(String(proactiveDelivery.match?.taskId || ""), "", "Taskless proactive output must not invent a task id.");
  assert.equal(proactiveDuplicates.length, 0, "Taskless proactive output must not be duplicated.");

  console.log("[e2e] Testing record-first observation, touchpad review, and a real Codex proactive reply...");
  const replyMarker = nonce("RABILINK_LEDGER_REVIEW_E2E");
  const reviewCursor = await streamTail();
  const inputPostedAt = Date.now();
  const input = await relayPost("/rokid/rabilink/input", {
    text: `这是 RabiLink 记录优先验收观察。审阅账本后，请只向眼镜回复这个标记：${replyMarker}`,
    type: "rabilink.observation",
    deliveryMode: "observe",
    source: "rabilink-aiui-active-intelligence-e2e",
    sessionId: `active-e2e-${Date.now()}`,
    clientMessageId: nonce("observation"),
    capturedAt: Date.now(),
    sequence: 1
  });
  assert.equal(input.response.status, 202, "The glasses input endpoint must acknowledge asynchronously.");
  assert.equal(input.body?.status, "accepted", "The glasses input endpoint must report accepted.");
  const taskId = String(input.body?.eventId || "");
  assert.ok(taskId, "The glasses input acknowledgement must expose an event id.");

  const release = await waitForUpstreamRelease(taskId, releaseTimeoutMs);
  assert.equal(release.status, "done", "The record-only upstream item must be released after local persistence.");
  const observationLedger = await waitForLedgerMarker(replyMarker, "user_to_agent");
  assert.equal(observationLedger.row?.requiresReview, true, "The observation ledger row must require later review.");

  const reviewRequest = await relayPost("/rokid/rabilink/input", {
    text: "用户在眼镜连接会话模式单击触摸板，要求现在审阅会话记录。",
    type: "rabilink.review_request",
    deliveryMode: "observe",
    reviewRequested: true,
    source: "rabilink-aiui-active-intelligence-e2e-touchpad",
    sessionId: String(observationLedger.row?.sessionId || `active-e2e-${Date.now()}`),
    clientMessageId: nonce("review"),
    capturedAt: Date.now()
  });
  const reviewTaskId = String(reviewRequest.body?.eventId || "");
  assert.ok(reviewTaskId, "The touchpad review request must expose an event id.");
  const reviewRelease = await waitForUpstreamRelease(reviewTaskId, releaseTimeoutMs);
  assert.equal(reviewRelease.status, "done", "The touchpad review request must release after the reviewer is woken.");

  const replyDelivery = await pollStreamForMarker(reviewCursor, replyMarker, replyTimeoutMs);
  const replyDuplicates = await collectMarkerDuplicates(replyDelivery.cursor, replyMarker, duplicateGraceMs);
  assert.equal(replyDelivery.match?.proactive, true, "A ledger review response must use the taskless proactive downlink.");
  assert.equal(replyDelivery.match?.final, true, "The Codex ledger review response must be final.");
  assert.equal(String(replyDelivery.match?.taskId || ""), "", "A record-first ledger review response must not inherit the observation task id.");
  assert.equal(replyDuplicates.length, 0, "The Codex ledger review response must not be duplicated.");
  assert.ok(release.releasedAt < replyDelivery.receivedAt, "The record-only upstream item must release before the reviewed reply arrives.");
  const replyLedger = await waitForLedgerMarker(replyMarker, "agent_to_user");
  assert.equal(replyLedger.file, observationLedger.file, "User observations and Agent downlinks must share one current conversation ledger.");

  const configuration = await testRemoteConfigurationRollback();

  const report = {
    generatedAt: new Date().toISOString(),
    ok: true,
    build: currentBuildEvidence(),
    architecture: "independent-inbound-and-outbound-queues",
    proactive: {
      acceptedByOutputGate: true,
      deliveredWithoutInputTask: true,
      proactive: proactiveDelivery.match.proactive === true,
      final: proactiveDelivery.match.final === true,
      taskless: !proactiveDelivery.match.taskId,
      duplicateCount: proactiveDuplicates.length,
      deliveryMs: proactiveDelivery.receivedAt - proactivePostedAt,
      markerDigest: digest(proactiveMarker)
    },
    recordFirstReview: {
      inputAcknowledged: true,
      upstreamStatus: release.status,
      upstreamReleaseMs: release.releaseMs,
      upstreamReleasedBeforeReply: release.releasedAt < replyDelivery.receivedAt,
      observationRecordedBeforeReview: true,
      touchpadReviewReleased: reviewRelease.status === "done",
      delivered: true,
      proactive: replyDelivery.match.proactive === true,
      final: replyDelivery.match.final === true,
      taskless: !replyDelivery.match.taskId,
      sharedLedger: replyLedger.file === observationLedger.file,
      duplicateCount: replyDuplicates.length,
      replyMs: replyDelivery.receivedAt - inputPostedAt,
      observationEventDigest: digest(taskId),
      reviewEventDigest: digest(reviewTaskId),
      markerDigest: digest(replyMarker)
    },
    configuration,
    security: {
      tokenStored: false,
      relayUrlStored: false,
      managerUrlStored: false,
      rawConversationStored: false
    }
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`[e2e] Active-intelligence dual queue passed; report=${reportPath}`);
}

try {
  await main();
} catch (error) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    security: {
      tokenStored: false,
      relayUrlStored: false,
      managerUrlStored: false,
      rawConversationStored: false
    }
  }, null, 2)}\n`, "utf8");
  throw error;
}
