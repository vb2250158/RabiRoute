import fs from "node:fs";
import path from "node:path";
import { canonicalLogicalPlanId, canonicalPlanStorageKey } from "./planStorageIdentity.js";

export type PlanPackageConflict = { planId?: string; transactionPath: string; message: string };
export type PlanPackageRecoverySnapshot = { conflicts: PlanPackageConflict[]; unknown: PlanPackageConflict[] };
export class PlanStoragePackageRecoveryPendingError extends Error {
  readonly code = "PLAN_STORAGE_PACKAGE_RECOVERY_PENDING";
  constructor(readonly conflict: PlanPackageConflict) {
    super(conflict.message);
    this.name = "PlanStoragePackageRecoveryPendingError";
  }
}

type PackageIdentity = { planId: string; storageId: string; transactionId: string; bucket: "active" | "archive"; inventoryHash: string; specHash: string; applied: boolean };
function transactionRoot(roleDir: string): string {
  return path.join(path.resolve(roleDir), "plans", "quarantine", "plan-storage-package-transactions");
}
function receiptPath(roleDir: string, storageId: string, transactionId: string): string {
  return path.join(path.resolve(roleDir), "plans", "quarantine", "plan-storage-package-receipts", storageId, `${transactionId}.json`);
}

/** Shared manifest/receipt identity check; payload validation remains with the recovery owner. */
export function validatePlanPackageRecoveryIdentity(roleDir: string, manifestPath: string, manifestText: string, receiptText?: string): PackageIdentity {
  let scopedPlanId: string | undefined;
  try {
    const value = JSON.parse(manifestText);
    if (value.schemaVersion !== 1 || value.kind !== "plan_storage_package_transaction" || value.status !== "prepared") throw new Error("Plan storage package transaction manifest is invalid.");
    const planId = canonicalLogicalPlanId(value.planId);
    const storageId = canonicalPlanStorageKey(planId);
    const transactionId = String(value.transactionId || "");
    const inventoryHash = String(value.inventoryHash || "").toLowerCase();
    if ((value.bucket !== "active" && value.bucket !== "archive") || value.storageId !== storageId || !/^[A-Za-z0-9_-]{1,128}$/.test(transactionId) || !/^[a-f0-9]{64}$/.test(inventoryHash)) throw new Error("Plan storage package transaction identity is invalid.");
    if (path.resolve(manifestPath) !== path.join(transactionRoot(roleDir), storageId, transactionId, "manifest.json")) throw new Error("Plan storage package transaction recovery scope mismatch.");
    scopedPlanId = planId;
    let applied = false;
    if (receiptText !== undefined) {
      const receipt = JSON.parse(receiptText);
      if (receipt?.schemaVersion !== 1 || receipt.kind !== "plan_storage_package_commit"
        || (receipt.status !== "applied" && receipt.status !== "conflict")
        || receipt.transactionId !== transactionId || receipt.planId !== planId || receipt.storageId !== storageId
        || receipt.bucket !== value.bucket || receipt.inventoryHash !== inventoryHash
        || !/^[a-f0-9]{64}$/.test(String(value.specHash || "")) || receipt.specHash !== value.specHash) throw new Error("Plan storage package transaction receipt identity mismatch.");
      applied = receipt.status === "applied";
    }
    return { planId, storageId, transactionId, bucket: value.bucket, inventoryHash, specHash: String(value.specHash || ""), applied };
  } catch (error) {
    throw new PlanStoragePackageRecoveryPendingError({ ...(scopedPlanId ? { planId: scopedPlanId } : {}), transactionPath: manifestPath, message: error instanceof Error ? error.message : String(error) });
  }
}

function conflictFor(identity: PackageIdentity, manifestPath: string): PlanPackageConflict | undefined {
  return identity.applied ? undefined : { planId: identity.planId, transactionPath: manifestPath, message: "Plan storage package transaction is pending recovery or conflict resolution." };
}
function append(snapshot: PlanPackageRecoverySnapshot, conflict: PlanPackageConflict | undefined): void {
  if (conflict) (conflict.planId ? snapshot.conflicts : snapshot.unknown).push(conflict);
}
function directoryNames(directory: string): string[] {
  try { return fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => entry.name).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
function optionalText(file: string): string | undefined {
  try {
    const before = fs.statSync(file);
    const fingerprint = `${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}`;
    const cached = textCache.get(file);
    if (cached?.fingerprint === fingerprint) return cached.text;
    const text = fs.readFileSync(file, "utf8");
    const after = fs.statSync(file);
    if (`${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}` !== fingerprint) throw new Error("Plan package recovery metadata changed while reading.");
    textCache.set(file, { fingerprint, text });
    if (textCache.size > 4096) textCache.delete(textCache.keys().next().value!);
    return text;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { textCache.delete(file); return undefined; } throw error; }
}
const textCache = new Map<string, { fingerprint: string; text: string }>();
export function readPlanPackageRecoveryIdentity(roleDir: string, manifestPath: string): PackageIdentity {
  const storageId = path.basename(path.dirname(path.dirname(manifestPath)));
  const transactionId = path.basename(path.dirname(manifestPath));
  const manifest = optionalText(manifestPath);
  if (manifest === undefined) throw new Error("Plan package recovery manifest is missing.");
  return validatePlanPackageRecoveryIdentity(roleDir, manifestPath, manifest, optionalText(receiptPath(roleDir, storageId, transactionId)));
}
export function capturePlanStoragePackageRecoveryConflicts(roleDir: string, planId?: string): PlanPackageRecoverySnapshot {
  const snapshot: PlanPackageRecoverySnapshot = { conflicts: [], unknown: [] };
  const root = transactionRoot(roleDir);
  for (const storageId of planId ? [canonicalPlanStorageKey(planId)] : directoryNames(root)) {
    for (const transactionId of directoryNames(path.join(root, storageId))) {
      const manifestPath = path.join(root, storageId, transactionId, "manifest.json");
      try { append(snapshot, conflictFor(readPlanPackageRecoveryIdentity(roleDir, manifestPath), manifestPath)); }
      catch (error) { append(snapshot, error instanceof PlanStoragePackageRecoveryPendingError ? error.conflict : { transactionPath: manifestPath, message: error instanceof Error ? error.message : String(error) }); }
    }
  }
  return snapshot;
}
export async function capturePlanStoragePackageRecoveryConflictsAsync(roleDir: string, planId?: string, signal?: AbortSignal): Promise<PlanPackageRecoverySnapshot> {
  const snapshot: PlanPackageRecoverySnapshot = { conflicts: [], unknown: [] };
  const root = transactionRoot(roleDir);
  const names = async (directory: string) => {
    signal?.throwIfAborted();
    try { return (await abortable(fs.promises.readdir(directory, { withFileTypes: true }), signal)).filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => entry.name).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  };
  for (const storageId of planId ? [canonicalPlanStorageKey(planId)] : await names(root)) {
    for (const transactionId of await names(path.join(root, storageId))) {
      signal?.throwIfAborted();
      const manifestPath = path.join(root, storageId, transactionId, "manifest.json");
      try {
        const manifest = await fs.promises.readFile(manifestPath, { encoding: "utf8", signal });
        let receipt: string | undefined;
        try { receipt = await fs.promises.readFile(receiptPath(roleDir, storageId, transactionId), { encoding: "utf8", signal }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        append(snapshot, conflictFor(validatePlanPackageRecoveryIdentity(roleDir, manifestPath, manifest, receipt), manifestPath));
      } catch (error) {
        signal?.throwIfAborted();
        append(snapshot, error instanceof PlanStoragePackageRecoveryPendingError ? error.conflict : { transactionPath: manifestPath, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return snapshot;
}
async function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([work, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}
export function assertPlanStoragePackageRecoverySnapshot(snapshot: PlanPackageRecoverySnapshot, planId?: string): void {
  const conflict = snapshot.unknown[0] ?? snapshot.conflicts.find(item => !planId || item.planId === planId);
  if (conflict) throw new PlanStoragePackageRecoveryPendingError(conflict);
}
export function assertPlanStoragePackageRecoveryReady(roleDir: string, planId: string): void {
  assertPlanStoragePackageRecoverySnapshot(capturePlanStoragePackageRecoveryConflicts(roleDir, planId), planId);
}
export async function assertPlanStoragePackageRecoveryReadyAsync(roleDir: string, planId: string, signal?: AbortSignal): Promise<void> {
  assertPlanStoragePackageRecoverySnapshot(await capturePlanStoragePackageRecoveryConflictsAsync(roleDir, planId, signal), planId);
}
