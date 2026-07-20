import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(projectRoot, "..", "..");
const relayServerPath = path.join(repoRoot, "scripts", "rabilink-relay-server.mjs");
const runtimeProofScriptPath = path.join(projectRoot, "scripts", "Test-RabiLinkAiuiRuntimeProof.ps1");
const reportPath = path.join(projectRoot, "dist", "relay-mobile-webgui-smoke.json");
const releaseVersion = String(JSON.parse(fs.readFileSync(path.join(projectRoot, "craft-release.json"), "utf8")).version || "").trim();

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { text };
  }
  return { response, body };
}

function runRuntimeProofCheck(baseUrl, outputPath) {
  let succeeded = true;
  try {
    execFileSync("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      runtimeProofScriptPath,
      "-RelayBaseUrl",
      baseUrl,
      "-Token",
      "test-token",
      "-ReportPath",
      outputPath
    ], { stdio: "pipe" });
  } catch {
    succeeded = false;
  }
  const report = JSON.parse(fs.readFileSync(outputPath, "utf8").replace(/^\uFEFF/, ""));
  return { succeeded, report };
}

async function waitForRelay(baseUrl, child, timeoutMs = 10000) {
  const startedAt = Date.now();
  let lastError = "";
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode != null) fail(`Relay server exited early with code ${child.exitCode}.`);
    try {
      const { response, body } = await fetchJson(`${baseUrl}/health`);
      if (response.ok && body?.name === "RabiLink Relay") return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(120);
  }
  fail(`Relay server did not become ready: ${lastError}`);
}

function writeAppStore(appStorePath, now) {
  fs.mkdirSync(path.dirname(appStorePath), { recursive: true });
  fs.writeFileSync(appStorePath, JSON.stringify({
    accounts: [{
      id: "account-test",
      username: "relay-smoke",
      createdAt: now,
      updatedAt: now
    }],
    apps: [{
      id: "app-test",
      name: "RabiLink AIUI Smoke",
      ownerAccountId: "account-test",
      enabled: true,
      token: "test-token",
      tokenPreview: "test...oken",
      notes: "",
      targetDeviceId: "pc-test",
      createdAt: now,
      updatedAt: now
    }],
    workers: [{
      id: "pc-test",
      guid: "guid-test",
      name: "PC Rabi Smoke",
      appId: "app-test",
      firstSeenAt: now,
      lastSeenAt: now
    }]
  }, null, 2), "utf8");
}

async function main() {
  assert(fs.existsSync(relayServerPath), `Relay server script not found: ${relayServerPath}`);
  const tempRoot = path.join(os.tmpdir(), `rabilink-relay-mobile-webgui-${process.pid}-${Date.now()}`);
  const appStorePath = path.join(tempRoot, "apps.json");
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const headers = { "X-RabiLink-Token": "test-token" };
  const now = new Date().toISOString();
  writeAppStore(appStorePath, now);

  let child;
  const relayOutput = [];
  try {
    child = spawn(process.execPath, [relayServerPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        RABILINK_RELAY_DATA_DIR: tempRoot,
        RABILINK_RELAY_APP_STORE_FILE: appStorePath,
        RABILINK_RELAY_WORKER_TASK_WAIT_MS: "5000",
        RABILINK_RELAY_WEBGUI_REQUEST_WAIT_MS: "5000",
        RABILINK_RELAY_LEASE_MS: "5000"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", (chunk) => relayOutput.push(String(chunk)));
    child.stderr.on("data", (chunk) => relayOutput.push(String(chunk)));
    await waitForRelay(baseUrl, child);

    const healthResult = await fetchJson(`${baseUrl}/health`);
    assert(
      Number(healthResult.body?.queue?.outboxTtlMs || 0) >= 48 * 60 * 60 * 1000,
      "The durable glasses downlink queue must retain offline messages for at least 48 hours independently of task cleanup."
    );

    const stateResult = await fetchJson(`${baseUrl}/api/rabilink/mobile/state`, { headers });
    assert(stateResult.response.status === 200, "Mobile state should authenticate with the app token.");
    assert(stateResult.body?.selectedWorker?.id === "pc-test", "Mobile state should expose the selected PC worker.");
    assert(stateResult.body?.selectedWorker?.online === true, "Selected PC worker should be online.");

    const inputResult = await fetchJson(`${baseUrl}/rokid/rabilink/input`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        text: "眼镜消息输入集成测试",
        type: "rabilink.observation",
        deliveryMode: "observe",
        source: "rabilink-aiui-smoke",
        clientMessageId: "segment-stream-smoke-1",
        sessionId: "stream-smoke",
        sequence: 1,
        capturedAt: Date.now()
      })
    });
    assert(inputResult.response.status === 202, "Glasses voice input should be acknowledged asynchronously.");
    assert(inputResult.body?.status === "accepted" && inputResult.body?.eventId, "Input acknowledgement should expose event identity and accepted state.");
    assert(!Object.hasOwn(inputResult.body || {}, "taskId"), "Input acknowledgement must not expose the Relay worker task lifecycle.");

    const taskClaim = await fetchJson(`${baseUrl}/worker/tasks?deviceId=pc-renamed&deviceName=${encodeURIComponent("PC Rabi Renamed")}&deviceGuid=guid-test&waitMs=0`, { headers });
    assert(taskClaim.response.status === 200 && taskClaim.body?.status === "claimed", "A worker whose display id changed must still claim its selected task by stable GUID.");
    assert(taskClaim.body?.tasks?.[0]?.id === inputResult.body.eventId, "The GUID-matched worker must receive the glasses input task.");
    assert(taskClaim.body?.tasks?.[0]?.type === "rabilink.observation" && taskClaim.body?.tasks?.[0]?.deliveryMode === "observe", "Relay must preserve record-only observation semantics for the PC worker.");
    assert(taskClaim.body?.tasks?.[0]?.clientMessageId === "segment-stream-smoke-1" && taskClaim.body?.tasks?.[0]?.sessionId === "stream-smoke", "Relay must preserve the client id and session metadata used by the unified ledger.");
    const finishTask = () => fetchJson(`${baseUrl}/worker/tasks/${encodeURIComponent(inputResult.body.eventId)}/finish`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        deviceId: "pc-renamed",
        deviceGuid: "guid-test",
        ok: true,
        status: "done",
        accepted: true
      })
    });
    const firstTaskFinish = await finishTask();
    const repeatedTaskFinish = await finishTask();
    assert(firstTaskFinish.response.status === 200 && firstTaskFinish.body?.status === "done", "The worker must release the inbound queue item after local acceptance.");
    assert(repeatedTaskFinish.response.status === 200 && repeatedTaskFinish.body?.deduplicated === true, "Repeating an uncertain task completion must be idempotent.");

    const offlineResult = await fetchJson(`${baseUrl}/worker/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        text: "这是眼镜首次连接前已经排队的主动提醒",
        source: "offline-active-intelligence-smoke",
        deliveryId: "offline-delivery-smoke",
        proactive: true
      })
    });
    assert(offlineResult.response.status === 200 && offlineResult.body?.status === "queued", "Codex must be able to queue a message while the glasses page is offline.");
    const backlogResult = await fetchJson(`${baseUrl}/rokid/rabilink/messages?stream=1&after=&waitMs=0`, { headers });
    assert(backlogResult.response.status === 200 && backlogResult.body?.shouldContinue === true, "A first glasses stream must open as a continuous queue.");
    assert(backlogResult.body?.messages?.length === 1 && backlogResult.body.messages[0]?.text === "这是眼镜首次连接前已经排队的主动提醒", "A first glasses stream must receive retained offline messages instead of skipping to the tail.");
    const streamCursor = String(backlogResult.body?.nextCursor || backlogResult.body?.cursor || "");
    const waitingStream = fetchJson(`${baseUrl}/rokid/rabilink/messages?stream=1&after=${encodeURIComponent(streamCursor)}&waitMs=5000`, { headers });
    await sleep(100);
    const proactiveResult = await fetchJson(`${baseUrl}/worker/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        text: "这是一条无前置任务的主动提醒",
        source: "active-intelligence-smoke"
      })
    });
    assert(proactiveResult.response.status === 200 && proactiveResult.body?.status === "queued", "A worker must be able to append a taskless proactive message.");
    const deliveredStream = await waitingStream;
    assert(deliveredStream.response.status === 200, "A waiting glasses stream must wake when proactive content arrives.");
    assert(deliveredStream.body?.messages?.length === 1, "The waiting stream must deliver the proactive message exactly once.");
    assert(deliveredStream.body.messages[0]?.text === "这是一条无前置任务的主动提醒", "The proactive message text must be preserved.");
    assert(deliveredStream.body.messages[0]?.proactive === true && !deliveredStream.body.messages[0]?.taskId, "Proactive delivery must be explicitly marked and remain taskless.");
    assert(deliveredStream.body?.shouldContinue === true, "The downlink stream must remain open after a proactive delivery.");

    const replyCursor = String(deliveredStream.body?.nextCursor || deliveredStream.body?.cursor || "");
    const waitingReplyStream = fetchJson(`${baseUrl}/rokid/rabilink/messages?stream=1&after=${encodeURIComponent(replyCursor)}&waitMs=5000`, { headers });
    await sleep(100);
    const replyResult = await fetchJson(`${baseUrl}/worker/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        text: "这是与上行任务关联的普通回复",
        source: "agent-reply-smoke",
        taskId: inputResult.body.eventId,
        proactive: false,
        final: true
      })
    });
    assert(replyResult.response.status === 200 && replyResult.body?.status === "queued", "A worker must be able to append an ordinary reply to the shared outbound queue.");
    const deliveredReplyStream = await waitingReplyStream;
    assert(deliveredReplyStream.response.status === 200, "A waiting glasses stream must wake when an ordinary reply arrives.");
    assert(deliveredReplyStream.body?.messages?.length === 1, "The waiting stream must deliver the ordinary reply exactly once.");
    assert(deliveredReplyStream.body.messages[0]?.taskId === inputResult.body.eventId, "The ordinary reply must preserve its upstream task identity.");
    assert(deliveredReplyStream.body.messages[0]?.proactive === false, "The ordinary reply must not be marked proactive.");
    assert(deliveredReplyStream.body.messages[0]?.final === true && deliveredReplyStream.body.messages[0]?.status === "reply", "The ordinary reply must be final and labelled as a reply.");

    const reliableCursor = String(deliveredReplyStream.body?.nextCursor || deliveredReplyStream.body?.cursor || "");
    const waitingReliableStream = fetchJson(`${baseUrl}/rokid/rabilink/messages?stream=1&after=${encodeURIComponent(reliableCursor)}&waitMs=5000`, { headers });
    await sleep(100);
    const reliableBody = {
      text: "这是一条可安全重试的主动消息",
      source: "active-intelligence-retry-smoke",
      deliveryId: "stable-delivery-smoke",
      proactive: true,
      final: true
    };
    const firstReliableAppend = await fetchJson(`${baseUrl}/worker/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(reliableBody)
    });
    const repeatedReliableAppend = await fetchJson(`${baseUrl}/worker/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(reliableBody)
    });
    assert(firstReliableAppend.response.status === 200 && firstReliableAppend.body?.deduplicated === false, "The first reliable outbound append must create one queue item.");
    assert(repeatedReliableAppend.response.status === 200 && repeatedReliableAppend.body?.deduplicated === true, "Repeating an uncertain outbound append must reuse the same queue item.");
    assert(repeatedReliableAppend.body?.messages?.[0]?.id === firstReliableAppend.body?.messages?.[0]?.id, "A retried outbound delivery id must resolve to the original queue item.");
    const deliveredReliableStream = await waitingReliableStream;
    assert(deliveredReliableStream.body?.messages?.length === 1, "A retried proactive append must reach the glasses stream exactly once.");
    assert(deliveredReliableStream.body.messages[0]?.text === reliableBody.text, "Reliable outbound delivery must preserve its text.");

    const portableInputResult = await fetchJson(`${baseUrl}/api/rabilink/devices/input`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        text: "手表端记录优先观察",
        sourceDeviceId: "watch-smoke",
        sourceDeviceName: "Wear smoke watch",
        sourceDeviceKind: "watch",
        transport: "wear-data-layer",
        clientMessageId: "watch-observation-smoke-1",
        capturedAt: Date.now()
      })
    });
    assert(portableInputResult.response.status === 202 && portableInputResult.body?.status === "accepted", "A portable device observation should enter the record-first input queue.");
    const portableTaskClaim = await fetchJson(`${baseUrl}/worker/tasks?deviceId=pc-renamed&deviceName=${encodeURIComponent("PC Rabi Renamed")}&deviceGuid=guid-test&waitMs=0`, { headers });
    assert(portableTaskClaim.response.status === 200 && portableTaskClaim.body?.status === "claimed", "The selected PC worker should claim a portable observation.");
    const portableTask = portableTaskClaim.body?.tasks?.[0];
    assert(portableTask?.id === portableInputResult.body.eventId, "The portable observation receipt and claimed task should share one event id.");
    assert(portableTask?.type === "rabilink.observation" && portableTask?.deliveryMode === "observe", "Portable input must default to record-first observation semantics.");
    assert(portableTask?.sourceDeviceId === "watch-smoke" && portableTask?.sourceDeviceKind === "watch", "Portable input must preserve source device identity and kind.");
    assert(portableTask?.transport === "wear-data-layer", "Portable input must preserve its phone/watch transport.");
    const portableTaskFinish = await fetchJson(`${baseUrl}/worker/tasks/${encodeURIComponent(portableInputResult.body.eventId)}/finish`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        deviceId: "pc-renamed",
        deviceGuid: "guid-test",
        ok: true,
        status: "done",
        accepted: true
      })
    });
    assert(portableTaskFinish.response.status === 200 && portableTaskFinish.body?.status === "done", "The worker should finish a locally recorded portable observation.");

    const fanoutCursor = String(deliveredReliableStream.body?.nextCursor || deliveredReliableStream.body?.cursor || "");
    const broadcastResult = await fetchJson(`${baseUrl}/worker/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        text: "所有便携端都可见的广播",
        source: "portable-fanout-smoke",
        deliveryId: "portable-broadcast-smoke",
        presentation: ["text"],
        priority: "normal"
      })
    });
    const watchOnlyBody = {
      text: "只投递到手表的主动提醒",
      source: "portable-fanout-smoke",
      deliveryId: "portable-watch-smoke",
      targetDeviceIds: ["watch-smoke"],
      targetDeviceKinds: ["watch"],
      presentation: ["notification", "haptic"],
      priority: "urgent"
    };
    const watchOnlyResult = await fetchJson(`${baseUrl}/worker/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(watchOnlyBody)
    });
    assert(broadcastResult.response.status === 200 && watchOnlyResult.response.status === 200, "Broadcast and targeted portable messages should queue successfully.");
    assert(watchOnlyResult.body?.messages?.[0]?.targetDeviceKinds?.[0] === "watch", "The Relay response should expose the normalized target selector.");
    assert(watchOnlyResult.body?.messages?.[0]?.presentation?.includes("haptic") && watchOnlyResult.body?.messages?.[0]?.priority === "urgent", "The Relay should preserve portable presentation hints and priority.");

    const glassesFanout = await fetchJson(`${baseUrl}/rokid/rabilink/messages?stream=1&after=${encodeURIComponent(fanoutCursor)}&waitMs=0`, { headers });
    const watchFanout = await fetchJson(`${baseUrl}/api/rabilink/devices/messages?deviceId=watch-smoke&deviceKind=watch&stream=1&after=${encodeURIComponent(fanoutCursor)}&waitMs=0`, { headers });
    const phoneFanout = await fetchJson(`${baseUrl}/api/rabilink/devices/messages?deviceId=phone-smoke&deviceKind=phone&stream=1&after=${encodeURIComponent(fanoutCursor)}&waitMs=0`, { headers });
    assert(glassesFanout.body?.messages?.length === 1 && glassesFanout.body.messages[0]?.text === "所有便携端都可见的广播", "The legacy glasses endpoint must receive broadcasts but skip watch-only messages.");
    assert(watchFanout.body?.messages?.length === 2, "A matching watch endpoint must receive broadcasts and watch-targeted messages.");
    assert(phoneFanout.body?.messages?.length === 1 && phoneFanout.body.messages[0]?.text === "所有便携端都可见的广播", "A phone endpoint must skip watch-only messages.");
    assert(glassesFanout.body?.nextCursor === watchOnlyResult.body?.messages?.[0]?.id, "A device cursor must advance past messages targeted to other devices.");
    assert(phoneFanout.body?.nextCursor === watchOnlyResult.body?.messages?.[0]?.id, "Each endpoint cursor must advance independently across filtered messages.");

    const missingPortableIdentity = await fetchJson(`${baseUrl}/api/rabilink/devices/messages?after=${encodeURIComponent(fanoutCursor)}&waitMs=0`, { headers });
    assert(missingPortableIdentity.response.status === 400, "The generic portable endpoint must require a device identity or kind.");
    const conflictingWatchRetry = await fetchJson(`${baseUrl}/worker/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...watchOnlyBody, targetDeviceIds: [], targetDeviceKinds: ["phone"] })
    });
    assert(conflictingWatchRetry.response.status === 409, "Reusing a delivery id with a different target audience must be rejected.");

    const proofSessionId = `rabilink-smoke-${Date.now()}`;
    const proofResult = await fetchJson(`${baseUrl}/api/rabilink/mobile/proof`, {
      method: "POST",
      headers: {
        ...headers,
        "user-agent": "RabiLink AIUI Smoke/0.1"
      },
      body: JSON.stringify({
        event: "smoke-runtime",
        sessionId: proofSessionId,
        detail: "Smoke proof from RabiLink AIUI test.",
        routeId: "route-smoke",
        panelId: "route",
        action: "smoke",
        status: "ok",
        runtime: {
          appName: "RabiLink AIUI",
          appVersion: releaseVersion
        },
        device: {
          userAgent: "RabiLink AIUI Smoke/0.1",
          model: "smoke"
        }
      })
    });
    assert(proofResult.response.status === 200, "Mobile runtime proof should authenticate and write successfully.");
    assert(proofResult.body?.proof?.event === "smoke-runtime", "Mobile runtime proof should preserve the event type.");
    assert(proofResult.body?.proof?.selectedWorker?.id === "pc-test", "Mobile runtime proof should include selected PC evidence.");

    const postRuntimeProof = async (event, sessionId, appVersion = releaseVersion) => await fetchJson(`${baseUrl}/api/rabilink/mobile/proof`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        event,
        sessionId,
        status: "ok",
        runtime: {
          appName: "RabiLink AIUI",
          appVersion
        }
      })
    });
    const splitStart = await postRuntimeProof("app-start", `${proofSessionId}-split-start`);
    const splitOperational = await postRuntimeProof("relay-connected", `${proofSessionId}-split-operational`);
    const oldVersionSession = `${proofSessionId}-old-version`;
    const oldVersionStart = await postRuntimeProof("app-start", oldVersionSession, "0.0.0");
    const oldVersionOperational = await postRuntimeProof("relay-connected", oldVersionSession, "0.0.0");
    assert(
      [splitStart, splitOperational, oldVersionStart, oldVersionOperational].every((result) => result.response.status === 200),
      "Runtime proof fixtures should write successfully."
    );
    const rejectedProofPath = path.join(tempRoot, "runtime-proof-rejected.json");
    const rejectedProofCheck = runRuntimeProofCheck(baseUrl, rejectedProofPath);
    assert(rejectedProofCheck.succeeded === false, "Runtime proof helper must reject split-session and old-version historical events.");
    assert(rejectedProofCheck.report.proved === false, "Rejected runtime proof report must remain unproved.");
    assert(!rejectedProofCheck.report.proof_session_id, "Rejected runtime proof must not select a partial page session.");

    const appStartProofResult = await fetchJson(`${baseUrl}/api/rabilink/mobile/proof`, {
      method: "POST",
      headers: {
        ...headers,
        "user-agent": "RabiLink AIUI Smoke/0.1"
      },
      body: JSON.stringify({
        event: "app-start",
        sessionId: proofSessionId,
        detail: "Local smoke app-start proof for runtime proof script.",
        routeId: "route-smoke",
        panelId: "route",
        action: "start",
        status: "ok",
        runtime: {
          appName: "RabiLink AIUI",
          appVersion: releaseVersion
        },
        device: {
          userAgent: "RabiLink AIUI Smoke/0.1",
          model: "smoke"
        }
      })
    });
    assert(appStartProofResult.response.status === 200, "Mobile app-start runtime proof should write successfully.");
    assert(appStartProofResult.body?.proof?.event === "app-start", "Mobile app-start proof should preserve the event type.");

    const relayConnectedProofResult = await fetchJson(`${baseUrl}/api/rabilink/mobile/proof`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        event: "relay-connected",
        sessionId: proofSessionId,
        detail: "Local smoke Relay connection proof for runtime proof script.",
        status: "ok",
        runtime: {
          appName: "RabiLink AIUI",
          appVersion: releaseVersion
        }
      })
    });
    assert(relayConnectedProofResult.response.status === 200, "Mobile relay-connected runtime proof should write successfully.");
    assert(relayConnectedProofResult.body?.proof?.sessionId === proofSessionId, "Mobile runtime proof should preserve its page session id.");

    const proofsResult = await fetchJson(`${baseUrl}/api/rabilink/mobile/proofs?limit=20`, { headers });
    assert(proofsResult.response.status === 200, "Mobile runtime proofs should be readable with the app token.");
    assert(Array.isArray(proofsResult.body?.proofs), "Mobile runtime proofs response should include a list.");
    assert(proofsResult.body.proofs.some((proof) => proof.event === "smoke-runtime"), "Mobile runtime proofs should include the smoke proof.");
    assert(proofsResult.body.proofs.some((proof) => proof.event === "app-start"), "Mobile runtime proofs should include the app-start proof.");
    assert(proofsResult.body.proofs.some((proof) => proof.event === "relay-connected"), "Mobile runtime proofs should include the Relay activity proof.");

    const runtimeProofReportPath = path.join(tempRoot, "runtime-proof-status.json");
    const runtimeProofCheck = runRuntimeProofCheck(baseUrl, runtimeProofReportPath);
    assert(runtimeProofCheck.succeeded === true, "Runtime proof helper should succeed after one current-version page session proves startup and Relay activity.");
    const runtimeProofReport = runtimeProofCheck.report;
    assert(runtimeProofReport.proved === true, "Runtime proof helper should require current-version startup and Relay activity from one recent page session.");
    assert(runtimeProofReport.latest_proof?.event === "relay-connected", "Runtime proof helper should report the latest same-session activity proof.");
    assert(runtimeProofReport.proof_session_id === proofSessionId, "Runtime proof helper should bind evidence to one page session.");
    assert(runtimeProofReport.expected_app_version === releaseVersion, "Runtime proof helper should bind evidence to the current Craft release version.");

    const blockedResult = await fetchJson(`${baseUrl}/api/rabilink/mobile/webgui?path=${encodeURIComponent("/api/private")}`, { headers });
    assert(blockedResult.response.status === 403, "Mobile WebGUI proxy should reject non-whitelisted PC paths.");

    const workerPollPromise = fetchJson(`${baseUrl}/worker/webgui-requests?deviceId=pc-renamed&deviceName=${encodeURIComponent("PC Rabi Renamed")}&deviceGuid=guid-test&waitMs=5000`, { headers });
    await sleep(100);
    const mobilePromise = fetchJson(`${baseUrl}/api/rabilink/mobile/webgui?path=${encodeURIComponent("/manager-config")}`, { headers });
    const workerPoll = await workerPollPromise;
    assert(workerPoll.response.status === 200, "PC worker should poll WebGUI requests successfully.");
    assert(workerPoll.body?.status === "claimed", "PC worker should claim the mobile WebGUI request.");
    assert(Array.isArray(workerPoll.body?.requests) && workerPoll.body.requests.length === 1, "PC worker should receive one WebGUI request.");
    const request = workerPoll.body.requests[0];
    assert(request.method === "GET", "Claimed request should preserve the PC WebGUI method.");
    assert(request.path === "/manager-config", "Claimed request should preserve the PC WebGUI path.");
    assert(request.targetDeviceId === "pc-test", "Claimed request should target the selected PC worker.");

    const pcBody = { code: 0, ok: true, source: "pc-rabi-smoke", config: { manager: { autoStart: true } } };
    const finishResult = await fetchJson(`${baseUrl}/worker/webgui-requests/${encodeURIComponent(request.id)}/response`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        deviceId: "pc-renamed",
        deviceGuid: "guid-test",
        statusCode: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
        bodyBase64: Buffer.from(JSON.stringify(pcBody), "utf8").toString("base64")
      })
    });
    assert(finishResult.response.status === 200, "PC worker should be able to complete the WebGUI request.");
    assert(finishResult.body?.request?.status === "done", "Completed WebGUI request should be marked done.");

    const mobileResult = await mobilePromise;
    assert(mobileResult.response.status === 200, "Mobile WebGUI response should use the PC response status.");
    assert(mobileResult.body?.source === "pc-rabi-smoke", "Mobile caller should receive the PC WebGUI JSON body.");
    assert(mobileResult.body?.config?.manager?.autoStart === true, "Mobile caller should receive nested PC config data.");

    const report = {
      generated_at: new Date().toISOString(),
      ok: true,
      base_url: baseUrl,
      relay_server: relayServerPath,
      selected_worker: stateResult.body.selectedWorker,
      message_input_status: inputResult.body.status,
      proactive_stream_message: deliveredStream.body.messages[0],
      reply_stream_message: deliveredReplyStream.body.messages[0],
      reliable_proactive_stream_message: deliveredReliableStream.body.messages[0],
      portable_input_task: portableTask,
      portable_fanout: {
        glasses_message_count: glassesFanout.body.messages.length,
        watch_message_count: watchFanout.body.messages.length,
        phone_message_count: phoneFanout.body.messages.length,
        advanced_cursor: glassesFanout.body.nextCursor
      },
      runtime_proof: proofResult.body.proof,
      app_start_runtime_proof: appStartProofResult.body.proof,
      runtime_proof_script: {
        proved: runtimeProofReport.proved,
        proof_count: runtimeProofReport.proof_count,
        latest_event: runtimeProofReport.latest_proof?.event || ""
      },
      blocked_path_status: blockedResult.response.status,
      proxied_path: request.path,
      pc_response_source: mobileResult.body.source
    };
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
    console.log(`RabiLink Relay message stream and mobile WebGUI smoke passed: ${reportPath}`);
  } catch (error) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify({
      generated_at: new Date().toISOString(),
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      relay_output: relayOutput.join("")
    }, null, 2), "utf8");
    throw error;
  } finally {
    if (child && child.exitCode == null) child.kill();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

await main();
