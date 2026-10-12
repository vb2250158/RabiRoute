import fs from "node:fs/promises";
import { TextDecoder } from "node:util";
import { agentSendIdempotencyPayload, prepareAgentSendRequest, type AgentSendRequest, type AgentSendResult } from "../agentSend.js";
import type { AgentReplyRequest, AgentReplyResult } from "../outbox.js";
import type { AgentSendHistoryEvidence, AgentSendHistoryState } from "./agentSendVerificationEvidence.js";
import { projectOriginalAgentSendBinding, type OriginalAgentSendBindingObservation } from "./agentSendOriginalBinding.js";
import { durableDeliveryRequestDigest } from "./durableDeliveryIdempotency.js";

export const MAX_AGENT_SEND_HISTORY_BYTES = 16 * 1024 * 1024;
export type AgentSendHistoryVerificationOptions = Readonly<{
  /** Trusted owner-selected path, never an HTTP-supplied path. */
  logPath: string;
  /** Inject the authoritative agentReplyDeliveryTrace capability, not a guessed digest. */
  traceReplyRequest: (request: AgentReplyRequest) => { deliveryId?: string; deliveryRequestDigest?: string };
  /** Owner projects business fields only; audit metadata must never escape. */
  projectResult: (data: Readonly<Record<string, unknown>>) => AgentReplyResult;
  /** Use the owner's existing AgentReplyResult -> AgentSendResult mapping. */
  mapResult: (result: AgentReplyResult, request: Readonly<AgentSendRequest>) => AgentSendResult;
}>;

function unavailable(): never { throw new Error("Original send history is not authoritative."); }
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }

class HistoryReadFailure extends Error {
  constructor(readonly state: AgentSendHistoryState) { super("Original send history is not authoritative."); }
}
async function readStableHistory(logPath: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try { handle = await fs.open(logPath, "r"); }
  catch (error) { throw new HistoryReadFailure((error as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "read_failed"); }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new HistoryReadFailure("read_failed");
    if (before.size > BigInt(MAX_AGENT_SEND_HISTORY_BYTES)) throw new HistoryReadFailure("oversized");
    const size = Number(before.size);
    // Fixed-position, bounded reads cannot follow an indefinitely growing log.
    const read = async () => {
      const bytes = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const result = await handle.read(bytes, offset, size - offset, offset);
        if (!result.bytesRead) throw new HistoryReadFailure("changed");
        offset += result.bytesRead;
      }
      return bytes;
    };
    const first = await read();
    const second = await read();
    const after = await handle.stat({ bigint: true });
    let current: typeof before;
    try { current = await fs.stat(logPath, { bigint: true }); }
    catch (error) { throw new HistoryReadFailure((error as NodeJS.ErrnoException)?.code === "ENOENT" ? "changed" : "read_failed"); }
    const same = (value: typeof before) => value.isFile() && value.dev === before.dev && value.ino === before.ino
      && value.size === before.size && value.mtimeNs === before.mtimeNs && value.ctimeNs === before.ctimeNs;
    if (!same(after) || !same(current) || !first.equals(second)) throw new HistoryReadFailure("changed");
    try { return new TextDecoder("utf-8", { fatal: true }).decode(first); }
    catch { throw new HistoryReadFailure("damaged"); }
  } catch (error) {
    throw error instanceof HistoryReadFailure ? error : new HistoryReadFailure("read_failed");
  } finally { await handle.close(); }
}

/** Read-only history observation for createAgentSendVerificationEvidenceVerifier.inspect.
 * Storage failures return enum-only diagnostics; invalid admission still throws a sanitized error.
 * No account/revision inference, network, delivery, recovery, or ledger writes. */
export async function inspectOriginalAgentSendHistory(
  originalRequest: Readonly<AgentSendRequest>, outerRequestDigest: string,
  options: AgentSendHistoryVerificationOptions
): Promise<AgentSendHistoryEvidence> {
  try {
    const request = structuredClone(originalRequest);
    const prepared = prepareAgentSendRequest(request);
    const payload = agentSendIdempotencyPayload(request);
    if (durableDeliveryRequestDigest(payload) !== outerRequestDigest) unavailable();
    const internal = structuredClone(prepared.internal);
    const trace = options.traceReplyRequest(internal);
    if (trace.deliveryId !== prepared.deliveryId || !nonempty(trace.deliveryRequestDigest)) unavailable();
    const identity = { deliveryId: prepared.deliveryId, requestDigest: outerRequestDigest };
    const unknown = (historyState: AgentSendHistoryState): AgentSendHistoryEvidence => ({ ...identity, historyConflict: false,
      historyState, inspection: { state: "uncertain", reason: "Original send history is not authoritative." } });
    let text: string;
    try { text = await readStableHistory(options.logPath); }
    catch (error) { return unknown(error instanceof HistoryReadFailure ? error.state : "read_failed"); }
    let damaged = Boolean(text && !text.endsWith("\n"));
    let conflict = false;
    let seen = false;
    let completed: AgentReplyResult | undefined;
    let terminalComplete = false;
    let uploadedFileId: string | undefined;
    let originalBinding: OriginalAgentSendBindingObservation | undefined;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let entry: Record<string, unknown> | undefined;
      try { entry = record(JSON.parse(line)); } catch { damaged = true; continue; }
      const data = record(entry?.data);
      if (!entry || !data || typeof entry.event !== "string") { damaged = true; continue; }
      const nested = record(data.request);
      const id = data.deliveryId ?? nested?.deliveryId;
      if (typeof id !== "string" || id.trim() !== trace.deliveryId) continue;
      seen = true;
      // Never derive a missing historical digest from a potentially incomplete nested request.
      if (!nonempty(data.deliveryRequestDigest)) { damaged = true; continue; }
      if (data.deliveryRequestDigest !== trace.deliveryRequestDigest) { conflict = true; continue; }
      if (nested && nonempty(nested.deliveryId) && nested.deliveryId !== trace.deliveryId) { damaged = true; continue; }
      if (data.ok !== true || data.status !== "sent") {
        if (entry.event === "group_file_caption_failed" || completed) terminalComplete = false;
        continue;
      }
      if (!nonempty(data.sentFileId) && !nonempty(data.sentMessageId)) continue;
      try { completed = options.projectResult(data); }
      catch { damaged = true; continue; }
      terminalComplete = false;
      const originalPayload = record(internal.payload);
      const hasCaption = nonempty(internal.text) || nonempty(originalPayload?.text);
      if (prepared.channel === "napcat" && internal.payloadType === "text" && entry.event === "reply_sent" && nonempty(data.sentMessageId)) {
        terminalComplete = true;
      } else if (prepared.channel === "napcat" && internal.payloadType === "file") {
        if (entry.event === "group_file_uploaded" && nonempty(data.sentFileId)) {
          const observedBinding = projectOriginalAgentSendBinding(data, {
            deliveryId: prepared.deliveryId, deliveryRequestDigest: trace.deliveryRequestDigest,
            routeId: prepared.routeId, groupId: prepared.target.groupId as string,
            instanceId: nonempty(internal.instanceId) ? internal.instanceId : undefined
          });
          if (originalBinding && durableDeliveryRequestDigest(originalBinding) !== durableDeliveryRequestDigest(observedBinding)) {
            originalBinding = { state: "conflict" };
          } else { originalBinding = observedBinding; }
          uploadedFileId = data.sentFileId;
          terminalComplete = !hasCaption;
        } else if (entry.event === "group_file_caption_sent" && nonempty(data.sentFileId)
          && data.sentFileId === uploadedFileId && nonempty(data.sentMessageId)
          && data.text === (originalPayload?.text ?? internal.text)) {
          terminalComplete = true;
        }
      }
    }
    // A known conflict outranks completion AND unrelated malformed records.
    if (conflict) return { ...identity, historyConflict: true, inspection: { state: "uncertain", reason: "Original send history has a payload conflict." } };
    if (damaged) return unknown("damaged");
    if (!seen) return unknown("request_not_found");
    if (!completed) return { ...identity, historyConflict: false, historyState: "terminal_missing",
      inspection: { state: "uncertain", reason: "Original terminal operation is unproven." } };
    let result: AgentSendResult;
    try { result = options.mapResult(structuredClone(completed), structuredClone(request)); }
    catch { return unknown("damaged"); }
    return { ...identity, historyConflict: false, historyState: terminalComplete ? "completed" : "terminal_missing",
      inspection: { state: "completed", result }, ...(terminalComplete ? { terminalComplete: true as const } : {}),
      ...(originalBinding ? { originalBinding } : {}) };
  } catch { return unavailable(); }
}
