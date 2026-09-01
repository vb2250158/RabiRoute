import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "./shared/filePersistence.js";
import { canonicalPlanStorageName, planDirectory } from "./planStorageLayout.js";
import {
  canonicalLogicalPlanId,
  canonicalPlanStorageCollisionKey,
  canonicalPlanStorageKey
} from "./planStorageIdentity.js";
import {
  exactPlanStorageDirectoryExists,
  inventoryPlanStorageDirectory,
  planStorageLeasePath,
  publishPlanStorageDirectoryUnderLease,
  requireCurrentPlanStorageLease,
  withPlanStorageLease,
  withPlanStorageLeaseAsync,
  type PlanStorageInventory,
  type PlanStorageInventoryEntry
} from "./planStorageRepository.js";
import {
  inspectPlanStorageConflict,
  readPlanStorageJsonObject as readJsonObject,
  type PlanStorageDominanceReason
} from "./planStoragePolicy.js";

export type { PlanStorageInventory, PlanStorageInventoryEntry } from "./planStorageRepository.js";
export {
  archivedPlanDirectoryDominatesActive,
  inspectPlanStorageConflict,
  validateCanonicalActivePlanDirectory,
  validateCanonicalArchivedPlanDirectory
} from "./planStoragePolicy.js";
export type { PlanStorageConflictInspection } from "./planStoragePolicy.js";
export {
  archivedPlanStorageFence,
  canonicalArchivedPlanExists,
  canonicalPlanIdForStorageIdentity,
  personaPlanStoragePath
} from "./personaPlanStorage.js";
export type { PersonaPlanStoragePath } from "./personaPlanStorage.js";
export {
  planStorageLeasePath as planStorageLockPath,
  withPlanStorageLease as withPlanStorageLock,
  withPlanStorageLeaseAsync as withPlanStorageLockAsync
} from "./planStorageRepository.js";

export type PlanStorageMigrationReceipt = {
  schemaVersion: 1;
  kind: "plan_storage_conflict_reconciliation";
  status: "prepared" | "reconciled";
  planId: string;
  idempotencyKey: string;
  reason: PlanStorageDominanceReason;
  originActivePath: string;
  canonicalArchivePath: string;
  quarantinePath: string;
  activeInventory: PlanStorageInventory;
  archiveInventory: PlanStorageInventory;
  preparedAt: string;
  reconciledAt?: string;
  occurrence?: "initial" | "reintroduced";
  occurrenceSequence?: number;
};

export type PlanStorageReconciliationResult = {
  planId: string;
  status: "no_conflict" | "ready" | "reconciled" | "already_reconciled" | "conflict";
  reason: string;
  receiptPath?: string;
  quarantinePath?: string;
  activeInventoryHash?: string;
  archiveInventoryHash?: string;
};

export type PlanStorageReconciliationOptions = {
  dryRun?: boolean;
  expectedActiveInventoryHash?: string;
  expectedArchiveInventoryHash?: string;
  now?: () => Date;
};

export type RolePlanStorageReconciliationResult = {
  reconciled: number;
  alreadyReconciled: number;
  conflicts: Array<{ planId: string; error: string }>;
  receipts: string[];
};

export type PlanStorageNameCanonicalizationResult = {
  migrated: number;
  recovered: number;
  failures: Array<{ planId: string; error: string }>;
  receipts: string[];
};

type PlanStorageNameMigrationReceipt = {
  schemaVersion: 1;
  kind: "plan_storage_name_canonicalization";
  status: "prepared" | "migrated";
  planId: string;
  bucket: "active" | "archive";
  sourcePath: string;
  canonicalPath: string;
  sourceInventory: PlanStorageInventory;
  canonicalInventory?: PlanStorageInventory;
  preparedAt: string;
  migratedAt?: string;
};

const ACTIVE_BUCKET = "active";
const ARCHIVE_BUCKET = "archive";
const PLAN_FILE = "plan.json";
const HISTORY_FILE = "history.jsonl";
const QUARANTINE_DIRECTORY = "quarantine";
const CONFLICT_QUARANTINE_DIRECTORY = "plan-storage-conflicts";
const NAME_MIGRATION_DIRECTORY = "plan-storage-name-migrations";
const PREPARED_RECEIPT_FILE = "migration-receipt.prepared.json";
const FINAL_RECEIPT_FILE = "migration-receipt.json";
function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedPlanId(planId: string): string {
  return canonicalLogicalPlanId(planId);
}

function planStorageId(planId: string): string {
  return canonicalPlanStorageKey(normalizedPlanId(planId));
}

export function canonicalPlanStorageIdentity(planId: string): string {
  return planStorageId(planId);
}

function plansRoot(roleDir: string): string {
  return path.join(roleDir, "plans");
}

export function planStorageDirectory(roleDir: string, planId: string, bucket: "active" | "archive"): string {
  return planDirectory(roleDir, normalizedPlanId(planId), bucket);
}

const inventoryDirectory = inventoryPlanStorageDirectory;
const exactDirectoryExists = exactPlanStorageDirectoryExists;

function nameMigrationReceiptPaths(
  roleDir: string,
  planId: string,
  bucket: "active" | "archive",
  sourceName: string
): { root: string; prepared: string; final: string } {
  const storageId = planStorageId(planId);
  const root = path.join(
    plansRoot(roleDir),
    QUARANTINE_DIRECTORY,
    NAME_MIGRATION_DIRECTORY,
    `${storageId}-${sha256(planId).slice(0, 12)}`,
    bucket,
    sha256(sourceName).slice(0, 24)
  );
  return {
    root,
    prepared: path.join(root, PREPARED_RECEIPT_FILE),
    final: path.join(root, FINAL_RECEIPT_FILE)
  };
}

function readNameMigrationReceipt(filePath: string): PlanStorageNameMigrationReceipt | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as PlanStorageNameMigrationReceipt;
    if (value?.schemaVersion !== 1 || value.kind !== "plan_storage_name_canonicalization") return null;
    return value;
  } catch {
    return null;
  }
}

function directChildPath(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative) && !relative.includes(path.sep));
}

function validateNameMigrationReceipt(roleDir: string, receipt: PlanStorageNameMigrationReceipt): void {
  const planId = normalizedPlanId(receipt.planId);
  if (receipt.status !== "prepared" && receipt.status !== "migrated") {
    throw new Error(`Plan storage name migration has an invalid state: ${planId}`);
  }
  if (receipt.bucket !== ACTIVE_BUCKET && receipt.bucket !== ARCHIVE_BUCKET) {
    throw new Error(`Plan storage name migration has an invalid bucket: ${planId}`);
  }
  const bucketRoot = path.join(plansRoot(roleDir), receipt.bucket);
  if (!directChildPath(bucketRoot, receipt.sourcePath) || !directChildPath(bucketRoot, receipt.canonicalPath)) {
    throw new Error(`Plan storage name migration escaped its bucket: ${planId}`);
  }
  if (path.basename(receipt.canonicalPath) !== planStorageId(planId)) {
    throw new Error(`Plan storage name migration has an invalid canonical target: ${planId}`);
  }
  if (path.basename(receipt.sourcePath) === path.basename(receipt.canonicalPath)) {
    throw new Error(`Plan storage name migration source is already canonical: ${planId}`);
  }
}

type RewrittenValue = { value: unknown; changed: boolean };

function rewriteManagedStoragePaths(value: unknown, sourcePath: string, canonicalPath: string): RewrittenValue {
  if (Array.isArray(value)) {
    let changed = false;
    const output = value.map((item) => {
      const rewritten = rewriteManagedStoragePaths(item, sourcePath, canonicalPath);
      changed ||= rewritten.changed;
      return rewritten.value;
    });
    return { value: output, changed };
  }
  if (!value || typeof value !== "object") return { value, changed: false };
  let changed = false;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "path" && typeof item === "string" && path.isAbsolute(item)) {
      const relative = path.relative(path.resolve(sourcePath), path.resolve(item));
      if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
        output[key] = path.join(canonicalPath, relative);
        changed ||= output[key] !== item;
        continue;
      }
    }
    const rewritten = rewriteManagedStoragePaths(item, sourcePath, canonicalPath);
    output[key] = rewritten.value;
    changed ||= rewritten.changed;
  }
  return { value: output, changed };
}

function renderManagedStorageRewrites(
  directory: string,
  sourcePath: string,
  canonicalPath: string
): Array<{ relativePath: string; content: string }> {
  const rewrites: Array<{ relativePath: string; content: string }> = [];
  const planFile = path.join(directory, PLAN_FILE);
  const planText = fs.readFileSync(planFile, "utf8");
  const planValue = JSON.parse(planText) as unknown;
  const rewrittenPlan = rewriteManagedStoragePaths(planValue, sourcePath, canonicalPath);
  if (rewrittenPlan.changed) {
    rewrites.push({ relativePath: PLAN_FILE, content: `${JSON.stringify(rewrittenPlan.value, null, 2)}\n` });
  }
  for (const relativePath of [HISTORY_FILE, "feedback.jsonl"]) {
    const filePath = path.join(directory, relativePath);
    if (!fs.existsSync(filePath)) continue;
    const source = fs.readFileSync(filePath, "utf8");
    const finalNewline = /\r?\n$/.test(source);
    let changed = false;
    const lines = source.split(/\r?\n/).map((line) => {
      if (!line) return line;
      const rewritten = rewriteManagedStoragePaths(JSON.parse(line) as unknown, sourcePath, canonicalPath);
      changed ||= rewritten.changed;
      return rewritten.changed ? JSON.stringify(rewritten.value) : line;
    });
    if (changed) {
      let content = lines.join("\n");
      if (finalNewline && !content.endsWith("\n")) content += "\n";
      rewrites.push({ relativePath, content });
    }
  }
  return rewrites;
}

function findPreparedNameMigrationReceipts(root: string): string[] {
  const receipts: string[] = [];
  const visit = (directory: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Plan storage name migration receipts contain a link: ${target}`);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name === PREPARED_RECEIPT_FILE) receipts.push(target);
    }
  };
  visit(root);
  return receipts.sort();
}

function completePreparedNameMigration(
  roleDir: string,
  preparedPath: string,
  receipt: PlanStorageNameMigrationReceipt,
  now: () => Date,
  afterRename?: () => void
): string {
  validateNameMigrationReceipt(roleDir, receipt);
  const lease = requireCurrentPlanStorageLease(roleDir, receipt.planId);
  const bucketRoot = path.join(plansRoot(roleDir), receipt.bucket);
  const sourceName = path.basename(receipt.sourcePath);
  const canonicalName = path.basename(receipt.canonicalPath);
  const sourceExists = exactDirectoryExists(bucketRoot, sourceName);
  const canonicalExists = exactDirectoryExists(bucketRoot, canonicalName);
  if (sourceExists && canonicalExists) {
    throw new Error(`Plan storage name migration target already exists beside its source: ${receipt.planId}`);
  }
  if (!sourceExists && !canonicalExists) {
    throw new Error(`Plan storage name migration lost both source and target: ${receipt.planId}`);
  }
  const currentPath = sourceExists ? receipt.sourcePath : receipt.canonicalPath;
  const beforeRewrite = inventoryDirectory(currentPath, lease);
  if (sourceExists && beforeRewrite.hash !== receipt.sourceInventory.hash) {
    throw new Error(`Plan storage name migration source inventory changed: ${receipt.planId}`);
  }
  const rewrites = renderManagedStorageRewrites(currentPath, receipt.sourcePath, receipt.canonicalPath);
  if (sourceExists) {
    publishPlanStorageDirectoryUnderLease(lease, receipt.sourcePath, receipt.canonicalPath);
    afterRename?.();
  }
  for (const rewrite of rewrites) {
    atomicWriteFileSync(path.join(receipt.canonicalPath, rewrite.relativePath), rewrite.content);
  }
  const canonicalInventory = inventoryDirectory(receipt.canonicalPath, lease);
  const completed: PlanStorageNameMigrationReceipt = {
    ...receipt,
    status: "migrated",
    canonicalInventory,
    migratedAt: now().toISOString()
  };
  const finalPath = path.join(path.dirname(preparedPath), FINAL_RECEIPT_FILE);
  atomicWriteFileSync(finalPath, `${JSON.stringify(completed, null, 2)}\n`);
  if (fs.existsSync(preparedPath)) fs.unlinkSync(preparedPath);
  return finalPath;
}

function migratePlanStorageNameUnderLock(
  roleDir: string,
  planId: string,
  bucket: "active" | "archive",
  sourceName: string,
  now: () => Date,
  afterRename?: () => void
): string {
  const canonicalName = planStorageId(planId);
  if (sourceName === canonicalName) throw new Error(`Plan storage directory is already canonical: ${planId}`);
  const bucketRoot = path.join(plansRoot(roleDir), bucket);
  const sourcePath = path.join(bucketRoot, sourceName);
  const canonicalPath = path.join(bucketRoot, canonicalName);
  if (!exactDirectoryExists(bucketRoot, sourceName)) {
    throw new Error(`Plan storage name migration source disappeared: ${planId}`);
  }
  if (exactDirectoryExists(bucketRoot, canonicalName)) {
    throw new Error(`Plan storage name migration target already exists: ${planId}`);
  }
  const plan = readJsonObject(path.join(sourcePath, PLAN_FILE));
  if (normalizedPlanId(String(plan.id || "")) !== planId) {
    throw new Error(`Plan storage name migration source identity changed: ${planId}`);
  }
  // Parse every managed JSON surface before publishing the prepared receipt so
  // malformed data fails without moving the directory.
  renderManagedStorageRewrites(sourcePath, sourcePath, canonicalPath);
  const sourceInventory = inventoryDirectory(sourcePath);
  const paths = nameMigrationReceiptPaths(roleDir, planId, bucket, sourceName);
  const finalReceipt = readNameMigrationReceipt(paths.final);
  if (finalReceipt?.status === "migrated") {
    throw new Error(`A migrated plan storage name was reintroduced: ${planId}`);
  }
  fs.mkdirSync(paths.root, { recursive: true });
  const receipt: PlanStorageNameMigrationReceipt = {
    schemaVersion: 1,
    kind: "plan_storage_name_canonicalization",
    status: "prepared",
    planId,
    bucket,
    sourcePath,
    canonicalPath,
    sourceInventory,
    preparedAt: now().toISOString()
  };
  atomicWriteFileSync(paths.prepared, `${JSON.stringify(receipt, null, 2)}\n`);
  return completePreparedNameMigration(roleDir, paths.prepared, receipt, now, afterRename);
}

export function canonicalizeRolePlanStorageDirectories(
  roleDir: string,
  options: { now?: () => Date; faultInjection?: { afterRename?: () => void } } = {}
): PlanStorageNameCanonicalizationResult {
  const now = options.now ?? (() => new Date());
  const result: PlanStorageNameCanonicalizationResult = {
    migrated: 0,
    recovered: 0,
    failures: [],
    receipts: []
  };
  const migrationRoot = path.join(plansRoot(roleDir), QUARANTINE_DIRECTORY, NAME_MIGRATION_DIRECTORY);
  for (const preparedPath of findPreparedNameMigrationReceipts(migrationRoot)) {
    const receipt = readNameMigrationReceipt(preparedPath);
    if (!receipt) {
      result.failures.push({ planId: "*:name-migration", error: `Invalid prepared plan storage name receipt: ${preparedPath}` });
      continue;
    }
    try {
      const finalPath = path.join(path.dirname(preparedPath), FINAL_RECEIPT_FILE);
      const finalReceipt = readNameMigrationReceipt(finalPath);
      if (finalReceipt?.status === "migrated") {
        if (fs.existsSync(preparedPath)) fs.unlinkSync(preparedPath);
        result.receipts.push(finalPath);
      } else {
        const recovered = withPlanStorageLease(roleDir, receipt.planId, () =>
          completePreparedNameMigration(roleDir, preparedPath, receipt, now, options.faultInjection?.afterRename)
        );
        result.recovered += 1;
        result.receipts.push(recovered);
      }
    } catch (error) {
      result.failures.push({ planId: receipt.planId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const bucket of [ACTIVE_BUCKET, ARCHIVE_BUCKET] as const) {
    const bucketRoot = path.join(plansRoot(roleDir), bucket);
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(bucketRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      result.failures.push({ planId: `*:${bucket}`, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const groups = new Map<string, Array<{ name: string; planId: string }>>();
    for (const entry of entries) {
      try {
        if (entry.isSymbolicLink() || !entry.isDirectory()) {
          throw new Error(`Plan storage contains a non-directory entry: ${entry.name}`);
        }
        const plan = readJsonObject(path.join(bucketRoot, entry.name, PLAN_FILE));
        const planId = normalizedPlanId(String(plan.id || ""));
        const identity = canonicalPlanStorageCollisionKey(planId);
        const candidates = groups.get(identity) ?? [];
        candidates.push({ name: entry.name, planId });
        groups.set(identity, candidates);
      } catch (error) {
        result.failures.push({ planId: entry.name, error: error instanceof Error ? error.message : String(error) });
      }
    }
    for (const [identity, candidates] of groups) {
      if (candidates.length !== 1) {
        result.failures.push({
          planId: identity,
          error: `Plan storage identity has ${candidates.length} physical directories in ${bucket}: ${candidates.map((entry) => entry.name).join(", ")}`
        });
        continue;
      }
      const candidate = candidates[0]!;
      const canonicalName = planStorageId(candidate.planId);
      if (candidate.name === canonicalName) continue;
      try {
        const receiptPath = withPlanStorageLease(roleDir, candidate.planId, () =>
          migratePlanStorageNameUnderLock(
            roleDir,
            candidate.planId,
            bucket,
            candidate.name,
            now,
            options.faultInjection?.afterRename
          )
        );
        result.migrated += 1;
        result.receipts.push(receiptPath);
      } catch (error) {
        result.failures.push({ planId: candidate.planId, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return result;
}

function quarantineRoot(roleDir: string, planId: string, activeInventoryHash: string): string {
  const normalized = normalizedPlanId(planId);
  return path.join(
    plansRoot(roleDir),
    QUARANTINE_DIRECTORY,
    CONFLICT_QUARANTINE_DIRECTORY,
    `${planStorageId(normalized)}-${sha256(normalized).slice(0, 12)}`,
    activeInventoryHash.slice(0, 24)
  );
}

function readReceipt(filePath: string): PlanStorageMigrationReceipt | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as PlanStorageMigrationReceipt;
  } catch {
    return null;
  }
}

function receiptResult(receiptPath: string, receipt: PlanStorageMigrationReceipt): PlanStorageReconciliationResult {
  return {
    planId: receipt.planId,
    status: "already_reconciled",
    reason: receipt.reason,
    receiptPath,
    quarantinePath: receipt.quarantinePath,
    activeInventoryHash: receipt.activeInventory.hash,
    archiveInventoryHash: receipt.archiveInventory.hash
  };
}

function finalizePreparedReceipt(
  receiptPath: string,
  preparedPath: string,
  receipt: PlanStorageMigrationReceipt,
  now: () => Date
): PlanStorageReconciliationResult | null {
  if (receipt.status !== "prepared" || !fs.existsSync(receipt.quarantinePath) || !fs.existsSync(receipt.canonicalArchivePath)) {
    return null;
  }
  const quarantined = inventoryDirectory(receipt.quarantinePath);
  const archive = inventoryDirectory(receipt.canonicalArchivePath);
  if (quarantined.hash !== receipt.activeInventory.hash || archive.hash !== receipt.archiveInventory.hash) {
    throw new Error(`Prepared plan reconciliation no longer matches its inventories: ${receipt.planId}`);
  }
  const completed: PlanStorageMigrationReceipt = {
    ...receipt,
    status: "reconciled",
    reconciledAt: now().toISOString()
  };
  atomicWriteFileSync(receiptPath, `${JSON.stringify(completed, null, 2)}\n`);
  if (fs.existsSync(preparedPath)) fs.unlinkSync(preparedPath);
  return receiptResult(receiptPath, completed);
}

function existingReceipt(roleDir: string, planId: string, now: () => Date): PlanStorageReconciliationResult | null {
  const normalized = normalizedPlanId(planId);
  const planRoot = path.join(
    plansRoot(roleDir),
    QUARANTINE_DIRECTORY,
    CONFLICT_QUARANTINE_DIRECTORY,
    `${planStorageId(normalized)}-${sha256(normalized).slice(0, 12)}`
  );
  if (!fs.existsSync(planRoot)) return null;
  const entries = fs.readdirSync(planRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const root = path.join(planRoot, entry.name);
    const finalPath = path.join(root, FINAL_RECEIPT_FILE);
    const finalReceipt = readReceipt(finalPath);
    if (finalReceipt?.status === "reconciled") return receiptResult(finalPath, finalReceipt);
    const preparedPath = path.join(root, PREPARED_RECEIPT_FILE);
    const prepared = readReceipt(preparedPath);
    if (prepared) {
      const finalized = finalizePreparedReceipt(finalPath, preparedPath, prepared, now);
      if (finalized) return finalized;
    }
  }
  return null;
}

export function reconcilePlanStorageConflictUnderLock(
  roleDir: string,
  planId: string,
  options: PlanStorageReconciliationOptions = {}
): PlanStorageReconciliationResult {
  const now = options.now ?? (() => new Date());
  const inspection = inspectPlanStorageConflict(roleDir, planId);
    if (inspection.status === "absent" || inspection.status === "single") {
      return existingReceipt(roleDir, planId, now) ?? {
        planId,
        status: "no_conflict",
        reason: inspection.reason
      };
    }
    if (inspection.status !== "reconcilable" || !inspection.activeInventory || !inspection.archiveInventory) {
      return { planId, status: "conflict", reason: inspection.reason };
    }
    if (options.expectedActiveInventoryHash
      && options.expectedActiveInventoryHash !== inspection.activeInventory.hash) {
      return { planId, status: "conflict", reason: "active_inventory_hash_changed" };
    }
    if (options.expectedArchiveInventoryHash
      && options.expectedArchiveInventoryHash !== inspection.archiveInventory.hash) {
      return { planId, status: "conflict", reason: "archive_inventory_hash_changed" };
    }
    if (options.dryRun) {
      return {
        planId,
        status: "ready",
        reason: inspection.reason,
        activeInventoryHash: inspection.activeInventory.hash,
        archiveInventoryHash: inspection.archiveInventory.hash
      };
    }
    const lease = requireCurrentPlanStorageLease(roleDir, planId);
    const reconciliationReason: PlanStorageDominanceReason = inspection.reason === "terminal_archive_temporally_dominates_legacy_active_snapshot"
      ? "terminal_archive_temporally_dominates_legacy_active_snapshot"
      : "archived_history_superset_dominates_reintroduced_completed_plan";

    const root = quarantineRoot(roleDir, planId, inspection.activeInventory.hash);
    const quarantinedActive = path.join(root, ACTIVE_BUCKET);
    const preparedPath = path.join(root, PREPARED_RECEIPT_FILE);
    const finalPath = path.join(root, FINAL_RECEIPT_FILE);
    if (fs.existsSync(root)) {
      const finalReceipt = readReceipt(finalPath);
      // A completed receipt is evidence for the previous move, not permission
      // to ignore a newly reintroduced active replica. Keeping both roots would
      // recreate the production fault while falsely reporting idempotent success.
      if (finalReceipt?.status === "reconciled" && !fs.existsSync(inspection.activePath)) {
        return receiptResult(finalPath, finalReceipt);
      }
      if (finalReceipt?.status === "reconciled"
        && fs.existsSync(quarantinedActive)
        && fs.existsSync(inspection.activePath)) {
        if (finalReceipt.activeInventory.hash !== inspection.activeInventory.hash
          || finalReceipt.archiveInventory.hash !== inspection.archiveInventory.hash) {
          return { planId, status: "conflict", reason: "reintroduced_active_or_archive_inventory_changed" };
        }
        const reintroducedRoot = path.join(root, "reintroduced");
        fs.mkdirSync(reintroducedRoot, { recursive: true });
        const sequence = fs.readdirSync(reintroducedRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && /^\d{6}$/.test(entry.name))
          .reduce((maximum, entry) => Math.max(maximum, Number(entry.name)), 0) + 1;
        const occurrenceRoot = path.join(reintroducedRoot, String(sequence).padStart(6, "0"));
        const occurrenceActive = path.join(occurrenceRoot, ACTIVE_BUCKET);
        const occurrencePrepared = path.join(occurrenceRoot, PREPARED_RECEIPT_FILE);
        const occurrenceFinal = path.join(occurrenceRoot, FINAL_RECEIPT_FILE);
        fs.mkdirSync(occurrenceRoot, { recursive: false });
        const occurrenceReceipt: PlanStorageMigrationReceipt = {
          schemaVersion: 1,
          kind: "plan_storage_conflict_reconciliation",
          status: "prepared",
          planId,
          idempotencyKey: sha256(JSON.stringify([
            planId,
            inspection.activeInventory.hash,
            inspection.archiveInventory.hash,
            "reintroduced",
            sequence
          ])),
          reason: reconciliationReason,
          originActivePath: inspection.activePath,
          canonicalArchivePath: inspection.archivePath,
          quarantinePath: occurrenceActive,
          activeInventory: inspection.activeInventory,
          archiveInventory: inspection.archiveInventory,
          preparedAt: now().toISOString(),
          occurrence: "reintroduced",
          occurrenceSequence: sequence
        };
        atomicWriteFileSync(occurrencePrepared, `${JSON.stringify(occurrenceReceipt, null, 2)}\n`);
        publishPlanStorageDirectoryUnderLease(lease, inspection.activePath, occurrenceActive);
        if (inventoryDirectory(occurrenceActive, lease).hash !== inspection.activeInventory.hash
          || inventoryDirectory(inspection.archivePath, lease).hash !== inspection.archiveInventory.hash) {
          throw new Error(`Reintroduced plan reconciliation inventory changed during the atomic move: ${planId}`);
        }
        const occurrenceCompleted: PlanStorageMigrationReceipt = {
          ...occurrenceReceipt,
          status: "reconciled",
          reconciledAt: now().toISOString()
        };
        atomicWriteFileSync(occurrenceFinal, `${JSON.stringify(occurrenceCompleted, null, 2)}\n`);
        fs.unlinkSync(occurrencePrepared);
        return {
          planId,
          status: "reconciled",
          reason: occurrenceCompleted.reason,
          receiptPath: occurrenceFinal,
          quarantinePath: occurrenceActive,
          activeInventoryHash: inspection.activeInventory.hash,
          archiveInventoryHash: inspection.archiveInventory.hash
        };
      }
      if (fs.existsSync(quarantinedActive)) {
        if (fs.existsSync(inspection.activePath)) {
          return { planId, status: "conflict", reason: "archived_active_replica_was_reintroduced_after_reconciliation" };
        }
        const prepared = readReceipt(preparedPath);
        if (prepared) {
          const finalized = finalizePreparedReceipt(finalPath, preparedPath, prepared, now);
          if (finalized) return finalized;
        }
        return { planId, status: "conflict", reason: "quarantine_exists_without_a_valid_receipt" };
      }
    }

    fs.mkdirSync(root, { recursive: true });
    const preparedAt = now().toISOString();
    const receipt: PlanStorageMigrationReceipt = {
      schemaVersion: 1,
      kind: "plan_storage_conflict_reconciliation",
      status: "prepared",
      planId,
      idempotencyKey: sha256(JSON.stringify([planId, inspection.activeInventory.hash, inspection.archiveInventory.hash])),
      reason: reconciliationReason,
      originActivePath: inspection.activePath,
      canonicalArchivePath: inspection.archivePath,
      quarantinePath: quarantinedActive,
      activeInventory: inspection.activeInventory,
      archiveInventory: inspection.archiveInventory,
      preparedAt,
      occurrence: "initial"
    };
    atomicWriteFileSync(preparedPath, `${JSON.stringify(receipt, null, 2)}\n`);
    publishPlanStorageDirectoryUnderLease(lease, inspection.activePath, quarantinedActive);
    const quarantinedInventory = inventoryDirectory(quarantinedActive, lease);
    const archiveAfterMove = inventoryDirectory(inspection.archivePath, lease);
    if (quarantinedInventory.hash !== inspection.activeInventory.hash
      || archiveAfterMove.hash !== inspection.archiveInventory.hash) {
      throw new Error(`Plan reconciliation inventory changed during the atomic move: ${planId}`);
    }
    const completed: PlanStorageMigrationReceipt = {
      ...receipt,
      status: "reconciled",
      reconciledAt: now().toISOString()
    };
    atomicWriteFileSync(finalPath, `${JSON.stringify(completed, null, 2)}\n`);
    fs.unlinkSync(preparedPath);
  return {
      planId,
      status: "reconciled",
      reason: completed.reason,
      receiptPath: finalPath,
      quarantinePath: quarantinedActive,
      activeInventoryHash: inspection.activeInventory.hash,
      archiveInventoryHash: inspection.archiveInventory.hash
    };
}

export function reconcilePlanStorageConflict(
  roleDir: string,
  planId: string,
  options: PlanStorageReconciliationOptions = {}
): PlanStorageReconciliationResult {
  return withPlanStorageLease(roleDir, planId, () =>
    reconcilePlanStorageConflictUnderLock(roleDir, planId, options)
  );
}

function planDirectories(
  roleDir: string,
  bucket: "active" | "archive"
): { plans: Map<string, string>; conflicts: Array<{ planId: string; error: string }> } {
  const directory = path.join(plansRoot(roleDir), bucket);
  try {
    const plans = new Map<string, string>();
    const conflicts: Array<{ planId: string; error: string }> = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      try {
        if (entry.isSymbolicLink() || !entry.isDirectory()) {
          throw new Error(`Plan storage contains a non-canonical entry: ${entry.name}`);
        }
        if (!fs.existsSync(path.join(directory, entry.name, PLAN_FILE))) {
          throw new Error(`Plan storage directory is missing plan.json: ${entry.name}`);
        }
        const raw = readJsonObject(path.join(directory, entry.name, PLAN_FILE));
        const planId = normalizedPlanId(String(raw.id || ""));
        if (planStorageId(planId) !== entry.name) {
          throw new Error(`Plan storage directory does not match plan.json id: ${entry.name}`);
        }
        const physicalKey = canonicalPlanStorageCollisionKey(planId);
        const previous = plans.get(physicalKey);
        if (previous && previous !== planId) {
          throw new Error(`Plan storage identity collision: ${previous} and ${planId}`);
        }
        plans.set(physicalKey, planId);
      } catch (error) {
        conflicts.push({
          planId: entry.name,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return { plans, conflicts };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { plans: new Map(), conflicts: [] };
    }
    return {
      plans: new Map(),
      conflicts: [{
        planId: `*:${bucket}`,
        error: error instanceof Error ? error.message : String(error)
      }]
    };
  }
}

export function reconcileRolePlanStorageConflicts(roleDir: string): RolePlanStorageReconciliationResult {
  const active = planDirectories(roleDir, ACTIVE_BUCKET);
  const archived = planDirectories(roleDir, ARCHIVE_BUCKET);
  const result: RolePlanStorageReconciliationResult = {
    reconciled: 0,
    alreadyReconciled: 0,
    conflicts: [...active.conflicts, ...archived.conflicts],
    receipts: []
  };
  for (const storageId of [...active.plans.keys()].filter((id) => archived.plans.has(id)).sort()) {
    const activePlanId = active.plans.get(storageId)!;
    const archivedPlanId = archived.plans.get(storageId)!;
    if (activePlanId !== archivedPlanId) {
      result.conflicts.push({
        planId: storageId,
        error: `Plan storage identity collision across buckets: ${activePlanId} and ${archivedPlanId}`
      });
      continue;
    }
    const planId = activePlanId;
    try {
      const outcome = reconcilePlanStorageConflict(roleDir, planId);
      if (outcome.status === "reconciled") result.reconciled += 1;
      else if (outcome.status === "already_reconciled") result.alreadyReconciled += 1;
      else if (outcome.status === "conflict") result.conflicts.push({ planId, error: outcome.reason });
      if (outcome.receiptPath) result.receipts.push(outcome.receiptPath);
    } catch (error) {
      result.conflicts.push({ planId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
