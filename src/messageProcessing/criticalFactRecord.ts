import fs from "node:fs";
import type {
  CriticalProjectFactDisposition,
  MessageProcessingRequirement
} from "./board.js";
import {
  getPlan,
  listConsolidatedMemories,
  listRecentMemories
} from "../roleKnowledge.js";
import {
  assertExistingPathWithinRoots,
  resolveRelativePathWithinRoot
} from "../shared/pathPolicy.js";

export type CriticalProjectFactRecordVerificationInput = {
  disposition?: CriticalProjectFactDisposition;
  requirement?: MessageProcessingRequirement;
  roleDir?: string;
  workspaceRoot: string;
};

function containsSourceEvidence(text: string, messageIds: string[]): boolean {
  return messageIds.some((messageId) => messageId && text.includes(messageId));
}

function allowedDocumentPath(workspaceRoot: string, relativePath: string): string {
  const resolved = resolveRelativePathWithinRoot(workspaceRoot, relativePath, {
    allowRoot: false,
    label: "Critical project fact document"
  });
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`Critical project fact document not found: ${relativePath}`);
  }
  return assertExistingPathWithinRoots(resolved, [workspaceRoot], "Critical project fact document");
}

export function verifyCriticalProjectFactRecord(input: CriticalProjectFactRecordVerificationInput): void {
  const disposition = input.disposition;
  const requirement = input.requirement;
  if (!requirement?.criticalFacts?.length || !disposition || disposition.status === "not_applicable") return;
  const record = disposition.record;
  if (!record) {
    throw new Error("Critical project fact record verification requires a typed record reference.");
  }
  const messageIds = requirement.source.messageIds.filter(Boolean);
  if (!messageIds.length) throw new Error("Critical project fact record verification requires source messageIds.");

  let serialized = "";
  if (record.type === "plan") {
    if (!input.roleDir) throw new Error("Critical project fact plan verification requires roleId.");
    const plan = getPlan(input.roleDir, record.planId);
    if (!plan) throw new Error(`Critical project fact plan not found: ${record.planId}`);
    serialized = JSON.stringify(plan);
  } else if (record.type === "memory") {
    if (!input.roleDir) throw new Error("Critical project fact memory verification requires roleId.");
    const memory = [
      ...listRecentMemories(input.roleDir),
      ...listConsolidatedMemories(input.roleDir)
    ].find((item) => item.id === record.memoryId);
    if (!memory) throw new Error(`Critical project fact memory not found: ${record.memoryId}`);
    serialized = JSON.stringify(memory);
  } else {
    const filePath = allowedDocumentPath(input.workspaceRoot, record.relativePath);
    serialized = fs.readFileSync(filePath, "utf8");
  }

  if (!containsSourceEvidence(serialized, messageIds)) {
    throw new Error(`Critical project fact record does not contain any source messageId: ${messageIds.join(", ")}`);
  }
}
