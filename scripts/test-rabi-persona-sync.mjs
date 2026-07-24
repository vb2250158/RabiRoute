import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = {
    managerUrl: "http://127.0.0.1:8790",
    peerId: "",
    roleId: "",
    outputPath: "",
    inspectOnly: false,
    requireLan: false,
    confirmDistinctPhysicalHosts: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--manager") options.managerUrl = String(argv[++index] || "");
    else if (argument === "--peer") options.peerId = String(argv[++index] || "");
    else if (argument === "--role") options.roleId = String(argv[++index] || "");
    else if (argument === "--output") options.outputPath = String(argv[++index] || "");
    else if (argument === "--inspect") options.inspectOnly = true;
    else if (argument === "--require-lan") options.requireLan = true;
    else if (argument === "--confirm-distinct-physical-hosts") options.confirmDistinctPhysicalHosts = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function managerBaseUrl(value) {
  const url = new URL(String(value || ""));
  const host = url.hostname.toLowerCase();
  if (!["127.0.0.1", "localhost", "::1"].includes(host) || url.username || url.password) {
    throw new Error("Persona sync acceptance must use a loopback Manager URL.");
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("Manager URL must use HTTP or HTTPS.");
  return url.origin;
}

async function requestJson(fetchImpl, url, init = {}, acceptedStatuses = [200]) {
  const response = await fetchImpl(url, init);
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    const contentType = String(response.headers.get("content-type") || "unknown").split(";", 1)[0];
    throw new Error(
      `Manager returned non-JSON for ${new URL(url).pathname} `
      + `(HTTP ${response.status}, content-type ${contentType}); the running Manager may not expose the current persona-sync API.`
    );
  }
  if (!acceptedStatuses.includes(response.status)) {
    throw new Error(String(body?.message || `Manager request failed: HTTP ${response.status}`));
  }
  return { status: response.status, body };
}

function manifestSummary(manifest) {
  const roles = Array.isArray(manifest?.roles) ? manifest.roles : [];
  return {
    roles: roles.length,
    files: roles.reduce((total, role) => total + (Array.isArray(role?.files) ? role.files.length : 0), 0)
  };
}

function counts(rows, field, allowedValues) {
  const allowed = new Set(allowedValues);
  return (Array.isArray(rows) ? rows : []).reduce((result, row) => {
    const candidate = String(row?.[field] || "unknown");
    const key = allowed.has(candidate) ? candidate : "unknown";
    result[key] = (result[key] || 0) + 1;
    return result;
  }, {});
}

function transportName(value) {
  const candidate = String(value || "").toLowerCase();
  return candidate === "lan" || candidate === "relay" ? candidate : "unknown";
}

function defaultOutputPath(now) {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  return path.join(REPO_ROOT, "data", "persona-sync", "acceptance", `persona-sync-${timestamp}.json`);
}

function writeEvidence(outputPath, report) {
  const target = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, target);
  return target;
}

export async function runPersonaSyncAcceptance(options = {}, dependencies = {}) {
  const now = dependencies.now?.() ?? new Date();
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const managerUrl = managerBaseUrl(options.managerUrl || "http://127.0.0.1:8790");
  const outputPath = options.outputPath || defaultOutputPath(now);
  const report = {
    schemaVersion: 2,
    kind: "persona_sync_physical_acceptance",
    generatedAt: now.toISOString(),
    mode: options.inspectOnly ? "inspect" : "sync",
    peerSelectionExplicit: Boolean(String(options.peerId || "").trim()),
    scope: options.roleId ? "single_persona" : "all_personas",
    requireLan: Boolean(options.requireLan),
    physicalHostsConfirmed: Boolean(options.confirmDistinctPhysicalHosts) && !options.inspectOnly,
    preflightPassed: false,
    syncPassed: false,
    formalAcceptanceEligible: false,
    acceptancePassed: false,
    status: "starting",
    checks: []
  };

  let exitCode = 1;
  try {
    const peersResponse = await requestJson(fetchImpl, `${managerUrl}/api/persona-sync/peers`);
    const peers = Array.isArray(peersResponse.body?.data?.peers) ? peersResponse.body.data.peers : [];
    const eligible = peers.filter(peer => peer?.online && Array.isArray(peer.capabilities) && peer.capabilities.includes("persona-sync"));
    let selected = null;
    const requestedPeerId = String(options.peerId || "").trim();
    if (requestedPeerId) selected = eligible.find(peer => peer.id === requestedPeerId || peer.guid === requestedPeerId) || null;
    else if (eligible.length === 1) selected = eligible[0];

    const manifestSuffix = options.roleId ? `?roleId=${encodeURIComponent(options.roleId)}` : "";
    const manifestResponse = await requestJson(fetchImpl, `${managerUrl}/api/persona-sync/manifest${manifestSuffix}`);
    report.preflight = {
      discoveredPeers: peers.length,
      eligiblePeers: eligible.length,
      peerSelected: Boolean(selected),
      localManifest: manifestSummary(manifestResponse.body?.data)
    };
    report.checks.push(
      { id: "peer_discovered", passed: Boolean(selected), actual: eligible.length },
      { id: "peer_online", passed: Boolean(selected?.online) },
      { id: "persona_sync_capability", passed: Boolean(selected?.capabilities?.includes("persona-sync")) }
    );
    if (!selected) {
      report.status = requestedPeerId ? "requested_peer_unavailable" : eligible.length > 1 ? "peer_selection_required" : "no_eligible_peer";
      exitCode = 2;
    } else {
      report.preflightPassed = true;
      if (options.inspectOnly) {
        report.status = "inspect_ready";
        exitCode = 0;
      } else {
        const syncResponse = await requestJson(fetchImpl, `${managerUrl}/api/persona-sync/sync`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ peerId: selected.id, ...(options.roleId ? { roleId: options.roleId } : {}) })
        }, [200, 409]);
        const sync = syncResponse.body?.data || {};
        const conflictsResponse = await requestJson(fetchImpl, `${managerUrl}/api/persona-sync/conflicts${manifestSuffix}`);
        const conflicts = Array.isArray(conflictsResponse.body?.data?.conflicts) ? conflictsResponse.body.data.conflicts : [];
        const transport = transportName(sync.transport);
        report.sync = {
          httpStatus: syncResponse.status,
          transport,
          files: Array.isArray(sync.files) ? sync.files.length : 0,
          directions: counts(sync.files, "direction", ["push", "pull", "converged", "conflict", "delete_local", "delete_remote"]),
          statuses: counts(sync.files, "status", ["created", "updated", "unchanged", "deleted", "merged", "conflict", "skipped"]),
          fileConflicts: Number(sync.fileConflicts || 0),
          semanticConflicts: Array.isArray(sync.semanticConflicts) ? sync.semanticConflicts.length : 0,
          conflicts: Number(sync.conflicts || 0),
          unresolvedConflictEvidence: {
            total: conflicts.length,
            remoteDeletionConflicts: conflicts.filter(conflict => conflict?.remoteDeleted === true).length,
            editedOrDivergedConflicts: conflicts.filter(conflict => conflict?.remoteDeleted !== true).length
          }
        };
        const transportPassed = !options.requireLan || transport === "lan";
        const noConflicts = syncResponse.status === 200 && Number(sync.conflicts || 0) === 0 && conflicts.length === 0;
        report.checks.push(
          { id: "sync_terminal_response", passed: [200, 409].includes(syncResponse.status), actual: syncResponse.status },
          { id: "transport_requirement", passed: transportPassed, actual: transport },
          { id: "no_unresolved_conflicts", passed: noConflicts, actual: Number(sync.conflicts || 0) + conflicts.length }
        );
        report.syncPassed = transportPassed && noConflicts;
        report.formalAcceptanceEligible = report.syncPassed && report.physicalHostsConfirmed;
        report.acceptancePassed = report.formalAcceptanceEligible;
        report.status = report.syncPassed ? "passed" : !transportPassed ? "transport_requirement_failed" : "conflicts_require_resolution";
        exitCode = report.syncPassed ? 0 : !transportPassed ? 4 : 3;
      }
    }
  } catch (error) {
    report.status = "failed";
    const message = error instanceof Error ? error.message : String(error);
    report.error = /returned non-JSON/.test(message)
      ? "manager_non_json_response"
      : /Manager request failed/.test(message)
        ? "manager_request_rejected"
        : "persona_sync_acceptance_failed";
    exitCode = 1;
  }
  report.exitCode = exitCode;
  const evidencePath = writeEvidence(outputPath, report);
  return { report, evidencePath, exitCode };
}

function helpText() {
  return [
    "Usage: node scripts/test-rabi-persona-sync.mjs [options]",
    "  --manager <loopback-url>  Manager URL (default http://127.0.0.1:8790)",
    "  --peer <id-or-guid>       Target peer; optional only when exactly one peer is eligible",
    "  --role <role-id>          Synchronize one persona instead of all personas",
    "  --inspect                 Discover and validate readiness without synchronizing",
    "  --require-lan             Fail acceptance when Relay fallback is used",
    "  --confirm-distinct-physical-hosts  Confirm this sync used two distinct physical PCs",
    "  --output <json-path>      Evidence path under local runtime storage by default",
    "Exit code 0 means the one-shot sync/inspection succeeded. Formal physical evidence also requires",
    "--confirm-distinct-physical-hosts plus the separate operator observation checklist."
  ].join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }
  const result = await runPersonaSyncAcceptance(options);
  process.stdout.write(`${JSON.stringify({
    status: result.report.status,
    syncPassed: result.report.syncPassed,
    formalAcceptanceEligible: result.report.formalAcceptanceEligible,
    acceptancePassed: result.report.acceptancePassed,
    preflightPassed: result.report.preflightPassed,
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
