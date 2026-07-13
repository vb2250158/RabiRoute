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

    const stateResult = await fetchJson(`${baseUrl}/api/rabilink/mobile/state`, { headers });
    assert(stateResult.response.status === 200, "Mobile state should authenticate with the app token.");
    assert(stateResult.body?.selectedWorker?.id === "pc-test", "Mobile state should expose the selected PC worker.");
    assert(stateResult.body?.selectedWorker?.online === true, "Selected PC worker should be online.");

    const inputResult = await fetchJson(`${baseUrl}/rokid/rabilink/input`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        text: "眼镜消息输入集成测试",
        type: "voice_transcript",
        source: "rabilink-aiui-smoke",
        sessionId: "stream-smoke",
        sequence: 1
      })
    });
    assert(inputResult.response.status === 202, "Glasses voice input should be acknowledged asynchronously.");
    assert(inputResult.body?.status === "accepted" && inputResult.body?.eventId, "Input acknowledgement should expose event identity and accepted state.");
    assert(!Object.hasOwn(inputResult.body || {}, "taskId"), "Input acknowledgement must not expose the Relay worker task lifecycle.");

    const tailResult = await fetchJson(`${baseUrl}/rokid/rabilink/messages?stream=1&tail=1&waitMs=0`, { headers });
    assert(tailResult.response.status === 200 && tailResult.body?.shouldContinue === true, "Connection conversation must bootstrap a continuous downlink cursor.");
    const streamCursor = String(tailResult.body?.nextCursor || tailResult.body?.cursor || "");
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

    const proofResult = await fetchJson(`${baseUrl}/api/rabilink/mobile/proof`, {
      method: "POST",
      headers: {
        ...headers,
        "user-agent": "RabiLink AIUI Smoke/0.1"
      },
      body: JSON.stringify({
        event: "smoke-runtime",
        detail: "Smoke proof from RabiLink AIUI test.",
        routeId: "route-smoke",
        panelId: "route",
        action: "smoke",
        status: "ok",
        runtime: {
          appName: "RabiLink AIUI",
          appVersion: "0.1.0"
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

    const appStartProofResult = await fetchJson(`${baseUrl}/api/rabilink/mobile/proof`, {
      method: "POST",
      headers: {
        ...headers,
        "user-agent": "RabiLink AIUI Smoke/0.1"
      },
      body: JSON.stringify({
        event: "app-start",
        detail: "Local smoke app-start proof for runtime proof script.",
        routeId: "route-smoke",
        panelId: "route",
        action: "start",
        status: "ok",
        runtime: {
          appName: "RabiLink AIUI",
          appVersion: "0.1.0"
        },
        device: {
          userAgent: "RabiLink AIUI Smoke/0.1",
          model: "smoke"
        }
      })
    });
    assert(appStartProofResult.response.status === 200, "Mobile app-start runtime proof should write successfully.");
    assert(appStartProofResult.body?.proof?.event === "app-start", "Mobile app-start proof should preserve the event type.");

    const proofsResult = await fetchJson(`${baseUrl}/api/rabilink/mobile/proofs?limit=5`, { headers });
    assert(proofsResult.response.status === 200, "Mobile runtime proofs should be readable with the app token.");
    assert(Array.isArray(proofsResult.body?.proofs), "Mobile runtime proofs response should include a list.");
    assert(proofsResult.body.proofs.some((proof) => proof.event === "smoke-runtime"), "Mobile runtime proofs should include the smoke proof.");
    assert(proofsResult.body.proofs.some((proof) => proof.event === "app-start"), "Mobile runtime proofs should include the app-start proof.");

    const runtimeProofReportPath = path.join(tempRoot, "runtime-proof-status.json");
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
      runtimeProofReportPath
    ], { stdio: "pipe" });
    const runtimeProofReport = JSON.parse(fs.readFileSync(runtimeProofReportPath, "utf8").replace(/^\uFEFF/, ""));
    assert(runtimeProofReport.proved === true, "Runtime proof helper should find the app-start proof.");
    assert(runtimeProofReport.latest_proof?.event === "app-start", "Runtime proof helper should report app-start as latest proof.");

    const blockedResult = await fetchJson(`${baseUrl}/api/rabilink/mobile/webgui?path=${encodeURIComponent("/api/private")}`, { headers });
    assert(blockedResult.response.status === 403, "Mobile WebGUI proxy should reject non-whitelisted PC paths.");

    const workerPollPromise = fetchJson(`${baseUrl}/worker/webgui-requests?deviceId=pc-test&deviceName=${encodeURIComponent("PC Rabi Smoke")}&deviceGuid=guid-test&waitMs=5000`, { headers });
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
        deviceId: "pc-test",
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
