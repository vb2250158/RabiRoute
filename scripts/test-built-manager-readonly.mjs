import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANAGER_ENTRY = path.join(REPO_ROOT, "dist", "manager.js");
const MANAGER_CONTROL_PLANE = path.join(REPO_ROOT, "dist", "manager", "controlPlaneRoutes.js");
const READ_ONLY_READY_LINE = "Manager read-only mode enabled: startup reconciliation and mutating HTTP methods are disabled.";

function timestamp(value) {
  return value.toISOString().replace(/[:.]/g, "-");
}

function defaultOutputPath(now) {
  return path.join(REPO_ROOT, "data", "acceptance", `built-manager-readonly-${timestamp(now)}.json`);
}

function atomicWriteJson(filePath, value) {
  const target = path.resolve(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return target;
}

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function builtArtifacts() {
  for (const filePath of [MANAGER_ENTRY, MANAGER_CONTROL_PLANE]) {
    if (!fs.existsSync(filePath)) throw new Error("Built Manager artifacts are missing. Run npm run build:backend first.");
  }
  return {
    managerEntrySha256: sha256(MANAGER_ENTRY),
    controlPlaneSha256: sha256(MANAGER_CONTROL_PLANE)
  };
}

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate a loopback Manager port."));
        return;
      }
      const port = address.port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function waitForManagerReady(child, port, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => finish(new Error("Built Manager did not become ready before the one-shot startup deadline.")), timeoutMs);
    const onData = chunk => {
      output = `${output}${chunk.toString("utf8")}`.slice(-16_384);
      if (output.includes(READ_ONLY_READY_LINE) && output.includes(`gateway-manager listening on http://127.0.0.1:${port}`)) {
        finish(null);
      }
    };
    const onExit = code => finish(new Error(`Built Manager exited before readiness (code ${String(code)}).`));
    const onError = () => finish(new Error("Built Manager process could not be started."));
    const finish = error => {
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error);
      else resolve();
    };
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function stopManager(child) {
  if (child.exitCode != null) return;
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.kill();
  const completed = await Promise.race([
    exited.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 5_000))
  ]);
  if (!completed && child.exitCode == null) child.kill("SIGKILL");
}

async function launchBuiltManager() {
  const port = await reserveLoopbackPort();
  const child = spawn(process.execPath, [MANAGER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      GATEWAY_MANAGER_HOST: "127.0.0.1",
      GATEWAY_MANAGER_PORT: String(port),
      RABIROUTE_MANAGER_AUTOSTART: "0",
      RABIROUTE_MANAGER_READ_ONLY: "1",
      REMOTE_AGENT_DISCOVERABLE: "0"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  child.stderr?.resume();
  try {
    await waitForManagerReady(child, port);
  } catch (error) {
    await stopManager(child);
    throw error;
  }
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stop: () => stopManager(child)
  };
}

async function requestJson(fetchImpl, baseUrl, pathname, boundaryName = pathname) {
  let response;
  try {
    response = await fetchImpl(`${baseUrl}${pathname}`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(30_000)
    });
  } catch (error) {
    throw new Error(
      `Built Manager read boundary did not complete for ${boundaryName}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Built Manager returned non-JSON for ${boundaryName} (HTTP ${response.status}).`);
  }
  if (response.status !== 200) throw new Error(`Built Manager read boundary failed for ${boundaryName} (HTTP ${response.status}).`);
  return { status: response.status, body };
}

function endpointCheck(id, response, count) {
  return { id, method: "GET", status: response.status, count, passed: response.status === 200 };
}

export async function collectBuiltManagerReadOnlySummary(baseUrl, fetchImpl = globalThis.fetch) {
  const [gateways, manifest, conflicts, speechMessages] = await Promise.all([
    requestJson(fetchImpl, baseUrl, "/gateways?summary=1"),
    requestJson(fetchImpl, baseUrl, "/api/persona-sync/manifest"),
    requestJson(fetchImpl, baseUrl, "/api/persona-sync/conflicts"),
    requestJson(fetchImpl, baseUrl, "/api/speech/messages?limit=1")
  ]);
  const manifestIndex = await requestJson(fetchImpl, baseUrl, "/api/persona-sync/index-status");
  const managers = Array.isArray(gateways.body?.data?.manager) ? gateways.body.data.manager : [];
  const roles = Array.isArray(manifest.body?.data?.roles) ? manifest.body.data.roles : [];
  const personaFileCount = roles.reduce((total, role) => total + (Array.isArray(role?.files) ? role.files.length : 0), 0);
  const conflictRows = Array.isArray(conflicts.body?.data?.conflicts) ? conflicts.body.data.conflicts : [];
  const speechRows = Array.isArray(speechMessages.body?.data?.records) ? speechMessages.body.data.records : [];
  const manifestIndexFiles = Number(manifestIndex.body?.data?.files || 0);
  const checks = [
    endpointCheck("gateway_summary", gateways, managers.length),
    endpointCheck("persona_sync_manifest", manifest, roles.length),
    endpointCheck("persona_sync_conflicts", conflicts, conflictRows.length),
    endpointCheck("host_speech_messages", speechMessages, speechRows.length),
    {
      id: "persona_sync_manifest_index",
      method: "GET",
      status: manifestIndex.status,
      count: manifestIndexFiles,
      state: String(manifestIndex.body?.data?.state || ""),
      watchMode: String(manifestIndex.body?.data?.watchMode || ""),
      passed: manifestIndex.status === 200
        && new Set(["ready", "fallback"]).has(String(manifestIndex.body?.data?.state || ""))
    }
  ];
  let identityCount = 0;
  let transcriptMatchedCount = 0;
  let transcriptReturnedCount = 0;
  let personasProbed = 0;
  if (roles.length > 0) {
    const personaSummaries = await Promise.all(roles.map(async role => {
      const roleId = String(role?.roleId || "").trim();
      if (!roleId) throw new Error("Persona sync manifest returned a persona without an id.");
      const rolePath = encodeURIComponent(roleId);
      const [identities, transcripts] = await Promise.all([
        requestJson(fetchImpl, baseUrl, `/api/roles/${rolePath}/voice-identities`, "persona_voice_identities"),
        requestJson(fetchImpl, baseUrl, `/api/roles/${rolePath}/voice-transcripts?limit=1`, "persona_voice_transcripts")
      ]);
      return {
        identities: Array.isArray(identities.body?.data?.identities) ? identities.body.data.identities.length : 0,
        matchedTranscripts: Number(transcripts.body?.data?.matchedCount || 0),
        returnedTranscripts: Array.isArray(transcripts.body?.data?.items) ? transcripts.body.data.items.length : 0
      };
    }));
    personasProbed = personaSummaries.length;
    identityCount = personaSummaries.reduce((total, item) => total + item.identities, 0);
    transcriptMatchedCount = personaSummaries.reduce((total, item) => total + item.matchedTranscripts, 0);
    transcriptReturnedCount = personaSummaries.reduce((total, item) => total + item.returnedTranscripts, 0);
    checks.push(
      { id: "persona_voice_identities", method: "GET", status: 200, count: identityCount, requests: personasProbed, passed: true },
      { id: "persona_voice_transcripts", method: "GET", status: 200, count: transcriptMatchedCount, requests: personasProbed, passed: true }
    );
  } else {
    checks.push({
      id: "persona_scoped_read_boundaries",
      method: "GET",
      status: 0,
      count: 0,
      passed: false,
      reason: "no_persona_available"
    });
  }
  return {
    counts: {
      gateways: managers.length,
      personas: roles.length,
      personasProbed,
      personaFiles: personaFileCount,
      personaManifestIndexFiles: manifestIndexFiles,
      personaSyncConflicts: conflictRows.length,
      returnedSpeechMessages: speechRows.length,
      personaVoiceIdentities: identityCount,
      matchedPersonaVoiceTranscripts: transcriptMatchedCount,
      returnedPersonaVoiceTranscripts: transcriptReturnedCount
    },
    checks
  };
}

export async function runBuiltManagerReadOnlyAcceptance(options = {}, dependencies = {}) {
  const now = dependencies.now?.() ?? new Date();
  const outputPath = options.outputPath || defaultOutputPath(now);
  const launch = dependencies.launchManager ?? launchBuiltManager;
  const report = {
    schemaVersion: 1,
    kind: "built_manager_readonly_acceptance",
    generatedAt: now.toISOString(),
    artifacts: builtArtifacts(),
    readOnlyMode: true,
    acceptancePassed: false,
    status: "starting",
    counts: {},
    checks: []
  };
  let handle;
  let exitCode = 1;
  try {
    handle = await launch();
    const summary = await collectBuiltManagerReadOnlySummary(handle.baseUrl, dependencies.fetchImpl ?? globalThis.fetch);
    report.counts = summary.counts;
    report.checks = [
      { id: "read_only_startup_mode", passed: true },
      ...summary.checks
    ];
    report.acceptancePassed = report.checks.every(check => check.passed === true);
    report.status = report.acceptancePassed ? "passed" : "incomplete";
    exitCode = report.acceptancePassed ? 0 : 2;
  } catch (error) {
    report.status = "failed";
    report.error = error instanceof Error ? error.message : String(error);
    exitCode = 1;
  } finally {
    await handle?.stop?.();
  }
  report.exitCode = exitCode;
  const evidencePath = atomicWriteJson(outputPath, report);
  return { report, evidencePath, exitCode };
}

async function main() {
  const result = await runBuiltManagerReadOnlyAcceptance();
  process.stdout.write(`${JSON.stringify({
    status: result.report.status,
    acceptancePassed: result.report.acceptancePassed,
    counts: result.report.counts,
    evidencePath: result.evidencePath
  }, null, 2)}\n`);
  return result.exitCode;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  });
}
