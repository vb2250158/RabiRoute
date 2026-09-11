import fs from "node:fs";
import path from "node:path";

export type PangHuIssueLedgerItem = {
  planId?: string;
  signature?: { groupId?: string; sourceMessageId?: string; module?: string; summary?: string };
};

/** The caller resolves the configured persona directory; install paths never own persona data. */
export function readPangHuIssueForPlan(roleDir: string, planId: string): PangHuIssueLedgerItem | undefined {
  const raw = JSON.parse(fs.readFileSync(path.join(roleDir, "state", "issue-threads.json"), "utf8")) as { items?: unknown };
  const items = Array.isArray(raw.items) ? raw.items : [];
  return items.find((item): item is PangHuIssueLedgerItem => item && typeof item === "object"
    && String((item as Record<string, unknown>).planId || "") === planId);
}
