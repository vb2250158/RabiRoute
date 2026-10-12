import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { MessageProcessingRequirement } from "../messageProcessing/board.js";
import { verifyCriticalProjectFactRecordInWorker } from "./criticalFactRead.js";
import { managerKnowledgePageWorkerPool } from "./managerReadWorkerPool.js";

test("critical record reads use the physical worker and preserve source evidence rejection", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "critical-read-worker-"));
  const file = path.join(root, "fact.md");
  const requirement: MessageProcessingRequirement = {
    id: "requirement-1", dedupeKey: "requirement-1", kind: "message_reply", replyPolicy: "required", status: "processing",
    source: { routeId: "example", roleId: "DemoPersona", endpoint: "group", conversationKey: "example", sender: "example", routeKinds: ["group_message"], messageIds: ["message-1"] },
    criticalFacts: [{ kind: "scope", evidence: "scope changed" }], createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z", dueAt: "2030-01-01T00:00:00.000Z"
  };
  const input = { workspaceRoot: root, requirement, disposition: { status: "recorded" as const, record: { type: "document" as const, relativePath: "fact.md" }, evidence: "message-1", verifiedAt: "2030-01-01T00:00:00.000Z" } };
  try {
    fs.writeFileSync(file, "Verified source: message-1");
    await verifyCriticalProjectFactRecordInWorker(input);
    fs.writeFileSync(file, "Missing source evidence");
    await assert.rejects(verifyCriticalProjectFactRecordInWorker(input), /does not contain any source messageId/);
  } finally { await managerKnowledgePageWorkerPool.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});
