import fs from "node:fs/promises";
import { TextDecoder } from "node:util";
import { prepareAgentSendRequest, type AgentSendRequest, type AgentSendResult } from "../agentSend.js";
import type { AgentReplyRequest, AgentReplyResult } from "../outbox.js";
import type { AgentSendHistoryEvidence } from "./agentSendVerificationEvidence.js";
import { durableDeliveryRequestDigest } from "./durableDeliveryIdempotency.js";

export const MAX_AGENT_SEND_HISTORY_BYTES = 16 * 1024 * 1024;
export type AgentSendHistoryVerificationOptions = Readonly<{
  /** Trusted owner-selected path, never an HTTP-supplied path. */
  logPath: string;
  /** Inject the authoritative agentReplyDeliveryTrace capability, not a guessed digest. */
  traceReplyRequest: (request: AgentReplyRequest) => { deliveryId?: string; deliveryRequestDigest?: string };
  /** Use the owner's existing AgentReplyResult -> AgentSendResult mapping. */
  mapResult: (result: AgentReplyResult, request: Readonly<AgentSendRequest>) => AgentSendResult;
}>;

function unavailable(): never { throw new Error("Original send history is not authoritative."); }
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }

async function readStableHistory(logPath: string): Promise<string> {
  const handle = await fs.open(logPath, "r");
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_AGENT_SEND_HISTORY_BYTES)) unavailable();
    const size = Number(before.size);
    // Fixed-position, bounded reads cannot follow an indefinitely growing log.
    const read = async () => {
      const bytes = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const result = await handle.read(bytes, offset, size - offset, offset);
        if (!result.bytesRead) unavailable();
        offset += result.bytesRead;
      }
      return bytes;
    };
    const first = await read();
    const second = await read();
    const after = await handle.stat({ bigint: true });
    const current = await fs.stat(logPath, { bigint: true });
    const same = (value: typeof before) => value.isFile() && value.dev === before.dev && value.ino === before.ino
      && value.size === before.size && value.mtimeNs === before.mtimeNs && value.ctimeNs === before.ctimeNs;
    if (!same(after) || !same(current) || !first.equals(second)) unavailable();
    return new TextDecoder("utf-8", { fatal: true }).decode(first);
  } finally { await handle.close(); }
}

/** Read-only history observation for createAgentSendVerificationEvidenceVerifier.inspect.
 * Unknown integrity throws a sanitized error (the factory converts it to unknown).
 * No account/revision inference, network, delivery, recovery, or ledger writes. */
export async function inspectOriginalAgentSendHistory(
  originalRequest: Readonly<AgentSendRequest>, outerRequestDigest: string,
  options: AgentSendHistoryVerificationOptions
): Promise<AgentSendHistoryEvidence> {
  try {
    const request = structuredClone(originalRequest);
    const prepared = prepareAgentSendRequest(request);
    const { deliveryId: _id, ...payload } = request;
    if (durableDeliveryRequestDigest(payload) !== outerRequestDigest) unavailable();
    const internal = structuredClone(prepared.internal);
    const trace = options.traceReplyRequest(internal);
    if (trace.deliveryId !== prepared.deliveryId || !nonempty(trace.deliveryRequestDigest)) unavailable();
    const text = await readStableHistory(options.logPath);
    let damaged = Boolean(text && !text.endsWith("\n"));
    let conflict = false;
    let seen = false;
    let completed: AgentReplyResult | undefined;
    let terminalComplete = false;
    let uploadedFileId: string | undefined;
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
      completed = data as unknown as AgentReplyResult;
      terminalComplete = false;
      const originalPayload = record(internal.payload);
      const hasCaption = nonempty(internal.text) || nonempty(originalPayload?.text);
      const managedFile = Boolean(originalPayload?.fileId || originalPayload?.planAttachment);
      if (prepared.channel === "napcat" && internal.payloadType === "text" && entry.event === "reply_sent" && nonempty(data.sentMessageId)) {
        terminalComplete = true;
      } else if (prepared.channel === "napcat" && internal.payloadType === "file" && !managedFile) {
        if (entry.event === "group_file_uploaded" && nonempty(data.sentFileId)) {
          uploadedFileId = data.sentFileId;
          terminalComplete = !hasCaption;
        } else if (entry.event === "group_file_caption_sent" && nonempty(data.sentFileId)
          && data.sentFileId === uploadedFileId && nonempty(data.sentMessageId)
          && data.text === (originalPayload?.text ?? internal.text)) {
          terminalComplete = true;
        }
      }
    }
    const identity = { deliveryId: prepared.deliveryId, requestDigest: outerRequestDigest };
    // A known conflict outranks completion AND unrelated malformed records.
    if (conflict) return { ...identity, historyConflict: true, inspection: { state: "uncertain", reason: "Original send history has a payload conflict." } };
    if (damaged || !seen) unavailable();
    if (!completed) return { ...identity, historyConflict: false, inspection: { state: "uncertain", reason: "Original terminal operation is unproven." } };
    const result = options.mapResult(structuredClone(completed), structuredClone(request));
    return { ...identity, historyConflict: false, inspection: { state: "completed", result }, ...(terminalComplete ? { terminalComplete: true as const } : {}) };
  } catch { return unavailable(); }
}
