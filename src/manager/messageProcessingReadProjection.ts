import fs from "node:fs";
import path from "node:path";
import type { MessageProcessingRequirement } from "../messageProcessing/board.js";
import { loadMessageProcessingContext, recoverReviewedMessageProcessingSourceRecord,
  type RecoverMessageProcessingSourceRecordOptions, type MessageProcessingContextRead } from "../messageProcessing/sourceContextRecovery.js";

export type MessageProcessingReadInput = {
  roleDir: string;
  requirement: Pick<MessageProcessingRequirement, "id" | "source" | "sourceEvidenceReview">;
  sourceMessageId?: string;
  reviewedSource?: RecoverMessageProcessingSourceRecordOptions;
};
export type MessageProcessingReadProjection = MessageProcessingContextRead;
export const MESSAGE_PROCESSING_READ_MAX_BYTES = 1024 * 1024;

export function assertMessageProcessingReadBudget(projection: MessageProcessingReadProjection): void {
  if (projection.records.length > 81 || Buffer.byteLength(JSON.stringify(projection), "utf8") > MESSAGE_PROCESSING_READ_MAX_BYTES) {
    throw new Error("Message-processing context exceeds the bounded reader transport budget.");
  }
}

function inventory(roleDir: string): string {
  const archive = path.join(roleDir, "conversation", "archive");
  let archives: string[];
  try { archives = fs.readdirSync(archive).filter(name => name.endsWith(".jsonl")).map(name => path.join(archive, name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; archives = []; }
  return JSON.stringify([
    path.join(roleDir, "conversation", "current.jsonl"), path.join(archive, "index.json"),
    path.join(roleDir, "message-context.jsonl"), path.join(roleDir, "group-messages.jsonl"), ...archives
  ].sort().map(file => {
    try { const stat = fs.statSync(file, { bigint: true }); return [file, String(stat.dev), String(stat.ino), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return [file, "missing"]; }
  }));
}

/** A bounded projection, not an atomic filesystem snapshot; observed changes fail closed. */
export function readMessageProcessingProjection(input: MessageProcessingReadInput): MessageProcessingReadProjection {
  const before = inventory(input.roleDir);
  const reviewedSource = input.reviewedSource
    ? recoverReviewedMessageProcessingSourceRecord(input.roleDir, input.requirement, input.sourceMessageId || "", input.reviewedSource)
    : undefined;
  const records = loadMessageProcessingContext({ ...input, limit: 80, maxChars: 24_000 });
  if (inventory(input.roleDir) !== before) throw new Error("Message context files changed during the read. Review again.");
  const projection = { records, ...(reviewedSource ? { reviewedSource } : {}) };
  assertMessageProcessingReadBudget(projection);
  return projection;
}
