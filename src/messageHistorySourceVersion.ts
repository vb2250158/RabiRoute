import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

type ArchiveVersion = { file: string; firstSequence: number; lastSequence: number; startedAt: string; endedAt: string };
export type MessageHistoryOwnerTarget = { stamp: string; records: number; layoutVersion: string; catalogStamp?: string };
export type MessageHistoryAppendProof = { layoutVersion: string; commits: readonly { stamp: string; records: number; startedAt?: number; committedAt?: number; catalogStamp?: string }[] };
export type MessageHistoryAppendCommit = { before: string; after: string; previousRecords: number; records: number; layoutVersion: string;
  startedAt?: number; committedAt?: number; beforeCatalogStamp?: string; catalogStamp?: string };
const proofs = new Map<string, MessageHistoryAppendProof>();

export function messageHistoryFileVersion(file: string): string {
  try { const stat = fs.statSync(file); return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
}

export function messageHistoryLayoutVersion(archives: readonly ArchiveVersion[]): string {
  return createHash("sha256").update(JSON.stringify(archives.map(item => ({ file: path.basename(item.file),
    first: item.firstSequence, last: item.lastSequence, start: item.startedAt, end: item.endedAt })))).digest("hex");
}

/** Ephemeral evidence from the source owner, never a substitute for durable index checkpoints. */
export function rememberMessageHistoryAppend(directory: string, commit: MessageHistoryAppendCommit): void {
  const key = path.resolve(directory);
  const previous = proofs.get(key);
  const continuous = previous?.layoutVersion === commit.layoutVersion && previous.commits.at(-1)?.stamp === commit.before
    && previous.commits.at(-1)?.records === commit.previousRecords && previous.commits.at(-1)?.catalogStamp === commit.beforeCatalogStamp;
  const commits = continuous ? [...previous!.commits] : [{ stamp: commit.before, records: commit.previousRecords, catalogStamp: commit.beforeCatalogStamp }];
  commits.push({ stamp: commit.after, records: commit.records, startedAt: commit.startedAt, committedAt: commit.committedAt, catalogStamp: commit.catalogStamp });
  proofs.delete(key);
  proofs.set(key, { layoutVersion: commit.layoutVersion, commits: commits.slice(-4096) });
  if (proofs.size > 128) proofs.delete(proofs.keys().next().value!);
}

/** A stat observed inside the owner's append window may precede its final file timestamp. */
export function messageHistoryObservationProven(proof: MessageHistoryAppendProof, stamp: string, observedAt: number, minimum: number): boolean {
  const exact = proof.commits.findIndex(commit => commit.stamp === stamp);
  if (exact >= minimum && exact >= 0) return true;
  const observed = stamp.split(":");
  for (let i = Math.max(1, minimum + 1); i < proof.commits.length; i++) {
    const before = proof.commits[i - 1]!.stamp.split(":"); const after = proof.commits[i]!.stamp.split(":");
    const commit = proof.commits[i]!;
    if (commit.startedAt !== undefined && commit.committedAt !== undefined && observedAt >= commit.startedAt && observedAt <= commit.committedAt
      && observed[0] === before[0] && observed[1] === before[1] && observed[0] === after[0] && observed[1] === after[1]
      && Number(observed[2]) >= Number(before[2]) && Number(observed[2]) <= Number(after[2])) return true;
  }
  return false;
}

/** An atomic catalog replacement may briefly be absent inside a later completed owner commit. */
export function messageHistoryCatalogObservationProven(proof: MessageHistoryAppendProof, stamp: string, observedAt: number, minimum: number): boolean {
  if (proof.commits.slice(minimum).some(commit => commit.catalogStamp === stamp)) return true;
  return stamp === "missing" && proof.commits.slice(Math.max(1, minimum + 1)).some(commit => commit.startedAt !== undefined
    && commit.committedAt !== undefined && observedAt >= commit.startedAt && observedAt <= commit.committedAt);
}

export function messageHistoryAppendProof(directory: string): MessageHistoryAppendProof | undefined {
  const proof = proofs.get(path.resolve(directory));
  return proof && proof.commits.length > 512 ? { ...proof, commits: proof.commits.slice(-512) } : proof;
}

export function discardMessageHistoryAppendProof(directory: string, expectedStamp: string, expectedCatalogStamp?: string): boolean {
  const key = path.resolve(directory);
  const current = proofs.get(key)?.commits.at(-1);
  if (current?.stamp !== expectedStamp || (expectedCatalogStamp !== undefined && current.catalogStamp !== expectedCatalogStamp)) return false;
  return proofs.delete(key);
}
