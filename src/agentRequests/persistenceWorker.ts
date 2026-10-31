import { getTimeoutMs } from "../shared/timeoutSettings.js";
import { AgentRequestState } from "./state.js";
import { JsonFileAgentRequestPersistence } from "./persistence.js";
import { AgentRequestPersistenceTransport } from "./persistenceTransport.js";
import { installDataMutationAuditSink, runWithOperationContext, type OperationContext, type RecordedDataMutationAudit } from "../observability/dataMutationAudit.js";
import { acquireFileLockSync } from "../shared/filePersistence.js";

if (!process.send || !process.argv[2]) throw new Error("Agent request persistence worker requires its owner IPC and state path.");
const port = {
  postMessage(value: unknown) { if (!process.send) throw new Error("Persistence owner disconnected."); process.send(value); },
  on(_event: "message", listener: (value: any) => void) { process.on("message", listener); },
  off(_event: "message", listener: (value: any) => void) { process.off("message", listener); },
  close() { if (process.connected) process.disconnect(); }
};
let state: AgentRequestState;
let revision = 0;
let clock = Date.now();
let stopping = false;
let fenced = false;
let currentAudit: RecordedDataMutationAudit[] = [];
let releaseOwner = () => {};
const stopAudit = installDataMutationAuditSink(record => currentAudit.push(record));
const methods = new Set(["bindEndpointDelivery", "markEndpointDispatching", "noteEndpointDeliveryFailure", "markEndpointNotSent",
  "commitEndpointReceipt", "reconcileOpenParties", "prepare", "bindResponseEvidence", "commit", "abort",
  "recordTargetTurnEnded", "recordPendingResponseCheck", "recordReminderResult", "cancel"]);
function failure(error: unknown) {
  if (!(error instanceof Error)) return { thrown: error };
  return { name: error.name, message: error.message, stack: error.stack, properties: Object.fromEntries(Object.entries(error).filter(([key]) => key !== "cause")) };
}
const wire = new AgentRequestPersistenceTransport(port, (id, value) => {
  void command(id, value).catch(error => { wire.stop(error instanceof Error ? error : new Error("Persistence transport failed.")); port.close(); });
}, error => { wire.stop(error instanceof Error ? error : new Error("Persistence transport failed.")); port.close(); });

async function command(id: string, value: unknown) {
  const request = value as { method: string; args: any[]; revision: number; timestamp: number; context?: OperationContext };
  if (stopping) return;
  if (request.method === "close") {
    stopping = true;
    stopAudit();
    releaseOwner();
    await wire.send(id, { ok: true, revision });
    wire.stop(new Error("Agent request persistence owner closed."));
    port.close();
    return;
  }
  currentAudit = [];
  try {
    if (fenced) throw Object.assign(new Error("Original Agent request commit requires reconciliation."), { code: "AGENT_REQUEST_COMMIT_UNKNOWN", commitState: "unknown", retryable: false });
    if (request.revision !== revision) throw new Error("Agent request owner revision mismatch.");
    clock = request.timestamp;
    if (request.method === "readEndpointDelivery" || request.method === "readCallerEndpointDelivery" || request.method === "listEndpointDeliveries" || request.method === "readRequests") {
      await wire.send(id, { ok: true, revision, value: request.method === "readEndpointDelivery"
        ? state.getEndpointDelivery(request.args[0]) : request.method === "readCallerEndpointDelivery" ? state.readCallerEndpointDelivery(request.args[0], request.args[1])
          : request.method === "readRequests" ? state.list() : state.listEndpointDeliveries() });
      return;
    }
    if (!methods.has(request.method)) throw new Error("Unknown Agent request persistence command.");
    const execute = () => state.transaction(() => {
      if (request.method === "reconcileOpenParties") {
        const resolutions = new Map(request.args[0] as Array<[string, { source: unknown; target: unknown }]>);
        return state.reconcileOpenParties((_party, record, role) => resolutions.get(record.id)?.[role] as any);
      }
      if (request.method === "recordTargetTurnEnded" && request.args[3] !== undefined) request.args[3] = new Date(request.args[3]);
      if (request.method === "noteEndpointDeliveryFailure" && request.args[1]?.__error) {
        request.args[1] = Object.assign(new Error(request.args[1].message), request.args[1].properties);
      }
      return Reflect.apply(Reflect.get(state, request.method), state, request.args);
    });
    const committed = request.context ? runWithOperationContext(request.context, execute) : execute();
    revision += 1;
    await wire.send(id, { ok: true, revision, value: committed.value, delta: committed.delta, audit: currentAudit });
  } catch (error) {
    if ((error as { commitState?: string })?.commitState === "unknown") fenced = true;
    await wire.send(id, { ok: false, revision, error: failure(error), audit: currentAudit });
  }
}

try {
  releaseOwner = acquireFileLockSync(`${process.argv[2]}.owner.lock`, { timeoutMs: getTimeoutMs("storage.deliveryOwnerLock", 1000), staleMs: 1000 });
  state = new AgentRequestState(new JsonFileAgentRequestPersistence(process.argv[2]), () => new Date(clock));
  await wire.send("ready", { revision, model: state.readModel() });
} catch (error) {
  await wire.send("ready", { error: failure(error) });
  releaseOwner();
  wire.stop(new Error("Agent request persistence initialization failed."));
  port.close();
}
