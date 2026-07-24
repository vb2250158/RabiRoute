import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PersonaSyncService } from "../personaSync.js";
import { PersonaSyncCoordinator } from "../personaSyncCoordinator.js";
import {
  findPersonaVoiceIdentity,
  personaVoiceIdentitiesPath,
  updatePersonaVoiceIdentity
} from "../personaVoiceIdentities.js";
import { PersonaSyncLanServer } from "../manager/personaSyncLanServer.js";
import { handlePersonaSyncApi } from "../manager/personaSyncRoutes.js";
import { RabiLinkRelayRuntime, type RabiLinkRelayRuntimeStatus } from "../manager/rabiLinkRelayRuntime.js";

const MODULE_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(MODULE_PATH), "..", "..");
const RELAY_ENTRY = path.join(REPO_ROOT, "scripts", "rabilink-relay-server.mjs");
const RELAY_READY_PREFIX = "RabiLink Relay listening on ";

export type PersonaSyncDualNodeOptions = {
  outputPath?: string;
  timeoutMs?: number;
};

export type PersonaSyncDualNodeDependencies = {
  now?: () => Date;
  tempRoot?: string;
};

function timestamp(value: Date): string {
  return value.toISOString().replace(/[:.]/g, "-");
}

function defaultOutputPath(now: Date): string {
  return path.join(REPO_ROOT, "data", "persona-sync", "acceptance", `dual-node-${timestamp(now)}.json`);
}

function atomicWriteJson(filePath: string, value: unknown): string {
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

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function oneShotDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not complete before the one-shot deadline.`)), timeoutMs);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); }
    );
  });
}

function listen(server: http.Server, host = "127.0.0.1", port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("Unable to resolve acceptance listener port."));
      else resolve(address.port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function waitForRelayReady(child: ChildProcess, timeoutMs: number): Promise<void> {
  return oneShotDeadline(new Promise<void>((resolve, reject) => {
    if (!child.stdout) {
      reject(new Error("RabiLink Relay stdout is unavailable for event-driven readiness."));
      return;
    }
    const stdout = child.stdout;
    let output = "";
    const finish = (error?: Error) => {
      stdout.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onData = (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-16_384);
      if (output.includes(RELAY_READY_PREFIX)) finish();
    };
    const onExit = (code: number | null) => finish(new Error(`RabiLink Relay exited before readiness (code ${String(code)}).`));
    const onError = (error: Error) => finish(error);
    stdout.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  }), timeoutMs, "RabiLink Relay readiness");
}

async function stopChild(child: ChildProcess | null, timeoutMs: number): Promise<void> {
  if (!child || child.exitCode != null) return;
  const exit = new Promise<void>(resolve => child.once("exit", () => resolve()));
  child.kill();
  try {
    await oneShotDeadline(exit, Math.min(timeoutMs, 5_000), "RabiLink Relay shutdown");
  } catch {
    if (child.exitCode == null) child.kill("SIGKILL");
  }
}

async function requestJson(url: string, init: RequestInit = {}, accepted = [200]): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(10_000) });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try { body = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch {
    throw new Error(`${new URL(url).pathname} returned invalid JSON (HTTP ${response.status}).`);
  }
  if (!accepted.includes(response.status)) {
    throw new Error(String(body.message || body.error || `${new URL(url).pathname} failed with HTTP ${response.status}.`));
  }
  return { response, body };
}

async function createRelayApplication(relayUrl: string): Promise<string> {
  const account = await requestJson(`${relayUrl}/manage/api/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "dual-node-acceptance", password: "dual-node-acceptance-password" })
  }, [200, 201]);
  const cookie = String(account.response.headers.get("set-cookie") || "").split(";", 1)[0];
  if (!cookie) throw new Error("RabiLink Relay account creation returned no session cookie.");
  const application = await requestJson(`${relayUrl}/manage/api/apps`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Dual-node acceptance" })
  }, [200, 201]);
  const app = application.body.app as Record<string, unknown> | undefined;
  const token = String(app?.token || "").trim();
  if (!token) throw new Error("RabiLink Relay application creation returned no token.");
  return token;
}

function runtimeOnlineWaiter(timeoutMs: number): {
  onStatus: (status: RabiLinkRelayRuntimeStatus) => void;
  next: () => Promise<void>;
} {
  let resolveCurrent: (() => void) | null = null;
  let rejectCurrent: ((error: Error) => void) | null = null;
  const onStatus = (status: RabiLinkRelayRuntimeStatus) => {
    if (status.state === "online") {
      resolveCurrent?.();
      resolveCurrent = null;
      rejectCurrent = null;
    } else if (status.state === "error") {
      rejectCurrent?.(new Error(status.error || status.message));
      resolveCurrent = null;
      rejectCurrent = null;
    }
  };
  const next = () => oneShotDeadline(new Promise<void>((resolve, reject) => {
    resolveCurrent = resolve;
    rejectCurrent = reject;
  }), timeoutMs, "RabiLink peer online event");
  return { onStatus, next };
}

function rows(filePath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).flatMap(line => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
  });
}

function check(id: string, passed: boolean, actual?: unknown): Record<string, unknown> {
  return { id, passed, ...(actual === undefined ? {} : { actual }) };
}

export async function runPersonaSyncDualNodeAcceptance(
  options: PersonaSyncDualNodeOptions = {},
  dependencies: PersonaSyncDualNodeDependencies = {}
): Promise<{ report: Record<string, unknown>; evidencePath: string; exitCode: number }> {
  const now = dependencies.now?.() ?? new Date();
  const timeoutMs = Math.max(5_000, Number(options.timeoutMs || 30_000));
  const outputPath = options.outputPath || defaultOutputPath(now);
  const fixtureRoot = fs.mkdtempSync(path.join(dependencies.tempRoot || os.tmpdir(), "rabiroute-dual-node-sync-"));
  const rolesA = path.join(fixtureRoot, "pc-a", "roles");
  const rolesB = path.join(fixtureRoot, "pc-b", "roles");
  const stateA = path.join(fixtureRoot, "pc-a", "sync-state");
  const stateB = path.join(fixtureRoot, "pc-b", "sync-state");
  const relayData = path.join(fixtureRoot, "relay");
  const roleId = "AcceptanceRole";
  const roleA = path.join(rolesA, roleId);
  const roleB = path.join(rolesB, roleId);
  const report: Record<string, unknown> = {
    schemaVersion: 1,
    kind: "persona_sync_dual_node_acceptance",
    generatedAt: now.toISOString(),
    isolatedFixture: true,
    realRelayServer: true,
    intervalPollingUsed: false,
    status: "starting",
    acceptancePassed: false,
    checks: []
  };
  let relayChild: ChildProcess | null = null;
  let peerServer: http.Server | null = null;
  let peerLan: PersonaSyncLanServer | null = null;
  let runtime: RabiLinkRelayRuntime | null = null;
  const manifestServices: PersonaSyncService[] = [];
  let exitCode = 1;
  try {
    fs.mkdirSync(path.join(roleA, "conversation"), { recursive: true });
    fs.mkdirSync(path.join(roleB, "conversation"), { recursive: true });
    fs.writeFileSync(path.join(roleA, "persona.md"), "shared persona\n", "utf8");
    fs.writeFileSync(path.join(roleB, "persona.md"), "shared persona\n", "utf8");
    fs.writeFileSync(path.join(roleA, "conversation", "current.jsonl"), `${JSON.stringify({ id: "from-a", time: 1, text: "A" })}\n`, "utf8");
    fs.writeFileSync(path.join(roleB, "conversation", "current.jsonl"), `${JSON.stringify({ id: "from-b", time: 2, text: "B" })}\n`, "utf8");
    fs.writeFileSync(path.join(roleA, "local.md"), "local file\n", "utf8");
    fs.writeFileSync(path.join(roleB, "remote.md"), "remote file\n", "utf8");
    fs.writeFileSync(path.join(roleA, "decision.md"), "shared decision\n", "utf8");
    fs.writeFileSync(path.join(roleB, "decision.md"), "shared decision\n", "utf8");
    updatePersonaVoiceIdentity(roleA, {
      sourceHostId: "acceptance-host",
      voiceprintId: "acceptance-voiceprint",
      displayName: "unknown",
      aliases: []
    });
    fs.mkdirSync(path.dirname(personaVoiceIdentitiesPath(roleB)), { recursive: true });
    fs.copyFileSync(personaVoiceIdentitiesPath(roleA), personaVoiceIdentitiesPath(roleB));
    updatePersonaVoiceIdentity(roleA, {
      sourceHostId: "acceptance-host",
      voiceprintId: "acceptance-voiceprint",
      displayName: "user branch",
      isUser: true,
      aliases: []
    });
    updatePersonaVoiceIdentity(roleB, {
      sourceHostId: "acceptance-host",
      voiceprintId: "acceptance-voiceprint",
      displayName: "other branch",
      isUser: false,
      aliases: []
    });

    const serviceA = new PersonaSyncService(() => rolesA, stateA);
    const serviceB = new PersonaSyncService(() => rolesB, stateB);
    manifestServices.push(serviceA, serviceB);
    const relayPort = await reservePort();
    const startedRelay = spawn(process.execPath, [RELAY_ENTRY], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(relayPort),
        RABILINK_RELAY_DATA_DIR: relayData,
        RABILINK_RELAY_WEBGUI_DIST_DIR: path.join(fixtureRoot, "missing-webgui")
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    relayChild = startedRelay;
    startedRelay.stderr?.resume();
    await waitForRelayReady(startedRelay, timeoutMs);
    const relayUrl = `http://127.0.0.1:${relayPort}`;
    const token = await createRelayApplication(relayUrl);
    const relayIdentity = () => ({ url: relayUrl, token, deviceId: "pc-a", deviceGuid: "guid-a" });
    const peerContext = {
      service: serviceB,
      coordinator: {} as PersonaSyncCoordinator,
      token: () => token,
      relay: () => ({ url: relayUrl, token, deviceId: "pc-b", deviceGuid: "guid-b" })
    };
    peerServer = http.createServer((request, response) => {
      const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
      if (!handlePersonaSyncApi(request, requestUrl, response, peerContext)) response.writeHead(404).end();
    });
    const peerPort = await listen(peerServer);
    peerLan = new PersonaSyncLanServer(peerContext, {
      host: "127.0.0.1",
      port: 0,
      addresses: () => ["127.0.0.1"]
    });
    await peerLan.start();
    const lanUrl = peerLan.peerUrls()[0];
    if (!lanUrl) throw new Error("Persona sync LAN listener did not publish a URL.");

    const online = runtimeOnlineWaiter(timeoutMs);
    runtime = new RabiLinkRelayRuntime({
      onStatus: online.onStatus,
      localRequestTimeoutMs: 3_000,
      localRequestAttempts: 1,
      relayWriteTimeoutMs: 3_000,
      relayWriteAttempts: 1
    });
    let onlineEvent = online.next();
    runtime.sync({
      enabled: true,
      url: relayUrl,
      token,
      deviceId: "pc-b",
      deviceGuid: "guid-b",
      deviceName: "Acceptance peer B",
      claimWaitMs: 1_000,
      localWebguiUrl: `http://127.0.0.1:${peerPort}`,
      peerUrls: [lanUrl],
      speechProxyEnabled: false,
      localSpeechUrl: "http://127.0.0.1:8781"
    });
    await onlineEvent;

    const coordinator = new PersonaSyncCoordinator(serviceA, stateA, relayIdentity);
    const first = await coordinator.sync("pc-b", roleId);
    const rowsA = rows(path.join(roleA, "conversation", "current.jsonl"));
    const rowsB = rows(path.join(roleB, "conversation", "current.jsonl"));
    const firstChecks = [
      check("lan_first_transport", first.transport === "lan", first.transport),
      check("lan_initial_file_conflicts_zero", first.fileConflicts === 0, first.fileConflicts),
      check("jsonl_union_on_both_nodes", rowsA.length === 2 && rowsB.length === 2, [rowsA.length, rowsB.length]),
      check("one_sided_files_converged", fs.existsSync(path.join(roleA, "remote.md")) && fs.existsSync(path.join(roleB, "local.md"))),
      check("voice_identity_semantic_conflict_exposed", first.semanticConflicts.length === 1, first.semanticConflicts.length)
    ];

    updatePersonaVoiceIdentity(roleA, {
      sourceHostId: "acceptance-host",
      voiceprintId: "acceptance-voiceprint",
      displayName: "final user",
      isUser: true,
      aliases: []
    });
    const semanticResolution = await coordinator.sync("pc-b", roleId);
    const semanticA = findPersonaVoiceIdentity(roleA, "acceptance-host", "acceptance-voiceprint");
    const semanticB = findPersonaVoiceIdentity(roleB, "acceptance-host", "acceptance-voiceprint");
    firstChecks.push(check(
      "voice_identity_conflict_explicitly_converged",
      semanticResolution.semanticConflicts.length === 0 && !semanticA?.conflicted && !semanticB?.conflicted
    ));

    fs.rmSync(path.join(roleB, "local.md"));
    const pulledDeletion = await coordinator.sync("pc-b", roleId);
    fs.rmSync(path.join(roleA, "remote.md"));
    const pushedDeletion = await coordinator.sync("pc-b", roleId);
    firstChecks.push(
      check("remote_deletion_propagated_to_local", pulledDeletion.fileConflicts === 0 && !fs.existsSync(path.join(roleA, "local.md"))),
      check("local_deletion_propagated_to_remote", pushedDeletion.fileConflicts === 0 && !fs.existsSync(path.join(roleB, "remote.md")))
    );

    fs.writeFileSync(path.join(roleA, "decision.md"), "LAN local decision\n", "utf8");
    fs.writeFileSync(path.join(roleB, "decision.md"), "LAN remote decision\n", "utf8");
    const lanConflict = await coordinator.sync("pc-b", roleId);
    const conflict = serviceA.listConflicts(roleId).find(item => item.path === "decision.md");
    if (!conflict) throw new Error("LAN divergence did not create conflict evidence.");
    const resolution = serviceA.resolveConflict({
      conflictId: conflict.conflictId,
      action: "keep_local",
      expectedLocalHash: conflict.localHash
    });
    const lanPublication = await coordinator.publishConflictResolution(resolution);
    firstChecks.push(
      check("lan_divergence_preserved_as_conflict", lanConflict.fileConflicts === 1, lanConflict.fileConflicts),
      check("lan_resolution_published", lanPublication.status === "published" && lanPublication.transport === "lan", lanPublication.transport),
      check("lan_resolution_converged_remote", fs.readFileSync(path.join(roleB, "decision.md"), "utf8") === "LAN local decision\n")
    );

    onlineEvent = online.next();
    runtime.sync({
      enabled: true,
      url: relayUrl,
      token,
      deviceId: "pc-b",
      deviceGuid: "guid-b",
      deviceName: "Acceptance peer B",
      claimWaitMs: 1_000,
      localWebguiUrl: `http://127.0.0.1:${peerPort}`,
      peerUrls: ["http://127.0.0.1:1"],
      speechProxyEnabled: false,
      localSpeechUrl: "http://127.0.0.1:8781"
    });
    await onlineEvent;
    fs.writeFileSync(path.join(roleB, "relay-only.md"), "relay fallback file\n", "utf8");
    const relayPull = await coordinator.sync("pc-b", roleId);
    const relayChecks = [
      check("relay_fallback_transport", relayPull.transport === "relay", relayPull.transport),
      check("relay_fallback_transferred_file", fs.readFileSync(path.join(roleA, "relay-only.md"), "utf8") === "relay fallback file\n")
    ];

    fs.writeFileSync(path.join(roleA, "decision.md"), "Relay local decision\n", "utf8");
    fs.writeFileSync(path.join(roleB, "decision.md"), "Relay remote decision\n", "utf8");
    const relayConflict = await coordinator.sync("pc-b", roleId);
    const relayEvidence = serviceA.listConflicts(roleId).find(item => item.path === "decision.md");
    if (!relayEvidence) throw new Error("Relay divergence did not create conflict evidence.");
    const relayResolution = serviceA.resolveConflict({
      conflictId: relayEvidence.conflictId,
      action: "keep_local",
      expectedLocalHash: relayEvidence.localHash
    });
    const relayPublication = await coordinator.publishConflictResolution(relayResolution);
    relayChecks.push(
      check("relay_divergence_preserved_as_conflict", relayConflict.fileConflicts === 1, relayConflict.fileConflicts),
      check("relay_resolution_published", relayPublication.status === "published" && relayPublication.transport === "relay", relayPublication.transport),
      check("relay_resolution_converged_remote", fs.readFileSync(path.join(roleB, "decision.md"), "utf8") === "Relay local decision\n")
    );

    const checks = [...firstChecks, ...relayChecks];
    report.artifacts = {
      runnerSha256: sha256(fs.readFileSync(MODULE_PATH)),
      relaySha256: sha256(fs.readFileSync(RELAY_ENTRY)),
      runnerKind: MODULE_PATH.includes(`${path.sep}dist${path.sep}`) ? "built" : "source"
    };
    report.transports = { lan: "passed", relay: "passed" };
    report.counts = {
      checks: checks.length,
      semanticConflictsObserved: first.semanticConflicts.length,
      fileConflictsObserved: lanConflict.fileConflicts + relayConflict.fileConflicts,
      unresolvedConflicts: serviceA.listConflicts(roleId).length
    };
    report.checks = checks;
    report.acceptancePassed = checks.every(item => item.passed === true) && serviceA.listConflicts(roleId).length === 0;
    report.status = report.acceptancePassed ? "passed" : "checks_failed";
    exitCode = report.acceptancePassed ? 0 : 2;
  } catch (error) {
    report.status = "failed";
    report.error = error instanceof Error ? error.message.replace(fixtureRoot, "<isolated-fixture>") : String(error);
    exitCode = 1;
  } finally {
    runtime?.stop();
    peerLan?.stop();
    for (const service of manifestServices) service.stopManifestIndex();
    if (peerServer) await closeServer(peerServer);
    await stopChild(relayChild, timeoutMs);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
  report.exitCode = exitCode;
  const evidencePath = atomicWriteJson(outputPath, report);
  return { report, evidencePath, exitCode };
}
