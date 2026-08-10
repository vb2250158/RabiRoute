import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync, withFileLockSync } from "./shared/filePersistence.js";
import type { ConversationSituation } from "./routing/conversationSituation.js";
import type { ForwardRouteKind } from "./routing/types.js";

const MAX_RETAINED_SITUATIONS = 200;

export type ConversationSituationSnapshot = ConversationSituation & {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  routeId: string;
  routeKind: ForwardRouteKind;
};

function situationsDir(roleDir: string): string {
  return path.join(roleDir, "conversation", "situations");
}

function safeId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function snapshotId(routeId: string, routeKind: ForwardRouteKind, situation: ConversationSituation): string {
  return `situation-${safeId([routeId, routeKind, situation.conversationId ?? "", ...situation.messageIds].join("\u0000"))}`;
}

function readSnapshot(filePath: string): ConversationSituationSnapshot | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<ConversationSituationSnapshot>;
    if (raw.schemaVersion !== 1 || typeof raw.id !== "string" || typeof raw.createdAt !== "string" || typeof raw.routeId !== "string" || typeof raw.routeKind !== "string") return undefined;
    if (!raw.speaker || !raw.addressing || !raw.topic || !raw.evidence || !raw.decisions || !Array.isArray(raw.messageIds)) return undefined;
    return raw as ConversationSituationSnapshot;
  } catch {
    return undefined;
  }
}

export function listConversationSituations(roleDir: string, limit = 30): ConversationSituationSnapshot[] {
  const directory = situationsDir(roleDir);
  if (!fs.existsSync(directory)) return [];
  const bounded = Math.max(1, Math.min(1_000, Math.floor(limit)));
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
    .flatMap(entry => {
      const snapshot = readSnapshot(path.join(directory, entry.name));
      return snapshot ? [snapshot] : [];
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
    .slice(0, bounded);
}

export function recordConversationSituation(
  roleDir: string,
  routeId: string,
  routeKind: ForwardRouteKind,
  situation: ConversationSituation
): ConversationSituationSnapshot | undefined {
  if (!situation.conversationId || situation.messageIds.length === 0) return undefined;
  const directory = situationsDir(roleDir);
  const id = snapshotId(routeId, routeKind, situation);
  const filePath = path.join(directory, `${id}.json`);
  return withFileLockSync(path.join(directory, ".write.lock"), () => {
    const previous = readSnapshot(filePath);
    const snapshot: ConversationSituationSnapshot = {
      ...situation,
      schemaVersion: 1,
      id,
      createdAt: previous?.createdAt ?? new Date().toISOString(),
      routeId,
      routeKind
    };
    atomicWriteFileSync(filePath, `${JSON.stringify(snapshot, null, 2)}\n`);
    const count = fs.readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith(".json")).length;
    if (count > MAX_RETAINED_SITUATIONS) {
      const stale = listConversationSituations(roleDir, 1_000).slice(MAX_RETAINED_SITUATIONS);
      for (const item of stale) {
        try { fs.unlinkSync(path.join(directory, `${item.id}.json`)); } catch { /* Derived shadow records may be reconstructed from the ledger. */ }
      }
    }
    return snapshot;
  });
}
