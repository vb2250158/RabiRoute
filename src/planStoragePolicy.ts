import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { canonicalLogicalPlanId } from "./planStorageIdentity.js";
import { isArchivedPlanStatus, planStorageDirectory } from "./planStorageLayout.js";
import {
  inventoryPlanStorageDirectory,
  type PlanStorageInventory
} from "./planStorageRepository.js";

const PLAN_FILE = "plan.json";
const HISTORY_FILE = "history.jsonl";

type PlanHistoryRecordLike = {
  id?: unknown;
  planId?: unknown;
  kind?: unknown;
  recordedAt?: unknown;
  before?: unknown;
  after?: unknown;
};

export type PlanStorageDominanceReason =
  | "archived_history_superset_dominates_reintroduced_completed_plan"
  | "terminal_archive_temporally_dominates_legacy_active_snapshot";

export type PlanStorageConflictInspection = {
  planId: string;
  status: "absent" | "single" | "reconcilable" | "conflict";
  reason: string;
  activePath: string;
  archivePath: string;
  activeInventory?: PlanStorageInventory;
  archiveInventory?: PlanStorageInventory;
};

export function readPlanStorageJsonObject(filePath: string): Record<string, unknown> {
  const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Plan storage JSON must contain an object: ${filePath}`);
  }
  return value as Record<string, unknown>;
}

function readHistory(filePath: string, planId: string): PlanHistoryRecordLike[] {
  if (!fs.existsSync(filePath)) return [];
  const records: PlanHistoryRecordLike[] = [];
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean)) {
    const value = JSON.parse(line) as PlanHistoryRecordLike;
    if (!value || typeof value !== "object" || value.planId !== planId || typeof value.id !== "string") {
      throw new Error(`Plan history contains an invalid record: ${filePath}`);
    }
    if (!value.after || typeof value.after !== "object") {
      throw new Error(`Plan history record has no after snapshot: ${filePath}`);
    }
    records.push(value);
  }
  return records;
}

function supportingFilesArePreserved(active: PlanStorageInventory, archive: PlanStorageInventory): boolean {
  const archiveByPath = new Map(archive.files.map((file) => [file.path, file]));
  return active.files
    .filter((file) => file.path !== PLAN_FILE && file.path !== HISTORY_FILE)
    .every((file) => {
      const archived = archiveByPath.get(file.path);
      return Boolean(archived && archived.bytes === file.bytes && archived.sha256 === file.sha256);
    });
}

export function planLineageDominanceReason(
  activeDirectory: string,
  archiveDirectory: string,
  planId: string
): PlanStorageDominanceReason | null {
  const id = canonicalLogicalPlanId(planId);
  const activePlan = readPlanStorageJsonObject(path.join(activeDirectory, PLAN_FILE));
  const archivePlan = readPlanStorageJsonObject(path.join(archiveDirectory, PLAN_FILE));
  if (activePlan.id !== id || archivePlan.id !== id) return null;
  if (isArchivedPlanStatus(activePlan.archiveStatus ?? activePlan.status)
    || !isArchivedPlanStatus(archivePlan.archiveStatus ?? archivePlan.status)) return null;
  if (activePlan.createdAt !== archivePlan.createdAt) return null;
  const activeUpdatedAt = Date.parse(String(activePlan.updatedAt || ""));
  const archiveUpdatedAt = Date.parse(String(archivePlan.updatedAt || ""));
  const archivedAt = Date.parse(String(archivePlan.archivedAt || ""));
  const terminalAt = Number.isFinite(archivedAt) ? archivedAt : archiveUpdatedAt;
  if (!Number.isFinite(activeUpdatedAt)
    || !Number.isFinite(archiveUpdatedAt)
    || activeUpdatedAt > archiveUpdatedAt
    || activeUpdatedAt > terminalAt) return null;
  if (activePlan.completedAt !== undefined && activePlan.completedAt !== archivePlan.completedAt) return null;

  const activeHistoryFile = path.join(activeDirectory, HISTORY_FILE);
  const archiveHistoryFile = path.join(archiveDirectory, HISTORY_FILE);
  const activeHistoryBytes = fs.existsSync(activeHistoryFile) ? fs.readFileSync(activeHistoryFile) : Buffer.alloc(0);
  const archiveHistoryBytes = fs.existsSync(archiveHistoryFile) ? fs.readFileSync(archiveHistoryFile) : Buffer.alloc(0);
  if (activeHistoryBytes.byteLength === 0 && archiveHistoryBytes.byteLength === 0) {
    return "terminal_archive_temporally_dominates_legacy_active_snapshot";
  }
  if (archiveHistoryBytes.byteLength < activeHistoryBytes.byteLength
    || !archiveHistoryBytes.subarray(0, activeHistoryBytes.byteLength).equals(activeHistoryBytes)) return null;

  const archiveHistory = readHistory(archiveHistoryFile, id);
  const activeHistory = readHistory(activeHistoryFile, id);
  if (archiveHistory.length === 0 || activeHistory.length > archiveHistory.length) return null;
  let transitionIndex = -1;
  for (let index = archiveHistory.length - 1; index >= 0; index -= 1) {
    const record = archiveHistory[index]!;
    if (record.kind === "archived"
      && isDeepStrictEqual(record.before, activePlan)
      && isArchivedPlanStatus((record.after as { archiveStatus?: unknown; status?: unknown })?.archiveStatus
        ?? (record.after as { status?: unknown })?.status)) {
      transitionIndex = index;
      break;
    }
  }
  if (transitionIndex < 0) return null;
  let expected = archiveHistory[transitionIndex]!.after;
  for (const record of archiveHistory.slice(transitionIndex + 1)) {
    if (record.kind !== "updated"
      || !isDeepStrictEqual(record.before, expected)
      || !isArchivedPlanStatus((record.after as { archiveStatus?: unknown; status?: unknown })?.archiveStatus
        ?? (record.after as { status?: unknown })?.status)) return null;
    expected = record.after;
  }
  return isDeepStrictEqual(expected, archivePlan)
    ? "archived_history_superset_dominates_reintroduced_completed_plan"
    : null;
}

export function validateCanonicalArchivedPlanDirectory(archiveDirectory: string, planId: string): void {
  const id = canonicalLogicalPlanId(planId);
  const inventory = inventoryPlanStorageDirectory(archiveDirectory);
  if (!inventory.files.some(file => file.path === PLAN_FILE)
    || !inventory.files.some(file => file.path === HISTORY_FILE)) {
    throw new Error(`Archived plan package is missing plan.json or history.jsonl: ${id}`);
  }
  const archivePlan = readPlanStorageJsonObject(path.join(archiveDirectory, PLAN_FILE));
  if (archivePlan.id !== id || !isArchivedPlanStatus(archivePlan.archiveStatus ?? archivePlan.status)) {
    throw new Error(`Archived plan package has an invalid terminal identity: ${id}`);
  }
  const history = readHistory(path.join(archiveDirectory, HISTORY_FILE), id);
  const transitionIndex = history.findIndex(record =>
    record.kind === "archived" && isArchivedPlanStatus((record.after as { archiveStatus?: unknown; status?: unknown })?.archiveStatus
      ?? (record.after as { status?: unknown })?.status)
  );
  if (transitionIndex < 0) throw new Error(`Archived plan package has no archived transition: ${id}`);
  let expected = history[transitionIndex]!.after;
  for (const record of history.slice(transitionIndex + 1)) {
    if (record.kind !== "updated"
      || !isDeepStrictEqual(record.before, expected)
      || !isArchivedPlanStatus((record.after as { archiveStatus?: unknown; status?: unknown })?.archiveStatus
        ?? (record.after as { status?: unknown })?.status)) {
      throw new Error(`Archived plan package history is not a terminal chain: ${id}`);
    }
    expected = record.after;
  }
  if (!isDeepStrictEqual(expected, archivePlan)) {
    throw new Error(`Archived plan package identity does not match its history tail: ${id}`);
  }
}

export function validateCanonicalActivePlanDirectory(activeDirectory: string, planId: string): void {
  const id = canonicalLogicalPlanId(planId);
  const inventory = inventoryPlanStorageDirectory(activeDirectory);
  if (!inventory.files.some(file => file.path === PLAN_FILE)
    || !inventory.files.some(file => file.path === HISTORY_FILE)) {
    throw new Error(`Active plan package is missing plan.json or history.jsonl: ${id}`);
  }
  const activePlan = readPlanStorageJsonObject(path.join(activeDirectory, PLAN_FILE));
  if (activePlan.id !== id || isArchivedPlanStatus(activePlan.archiveStatus ?? activePlan.status)) {
    throw new Error(`Active plan package has an invalid live identity: ${id}`);
  }
  const history = readHistory(path.join(activeDirectory, HISTORY_FILE), id);
  if (history.length === 0 || history.some(record => record.kind === "archived")) {
    throw new Error(`Active plan package history is missing or contains a terminal transition: ${id}`);
  }
  if (!isDeepStrictEqual(history.at(-1)?.after, activePlan)) {
    throw new Error(`Active plan package identity does not match its history tail: ${id}`);
  }
}

export function archivedPlanDirectoryDominatesActive(
  activeDirectory: string,
  archiveDirectory: string,
  planId: string
): boolean {
  return planLineageDominanceReason(activeDirectory, archiveDirectory, canonicalLogicalPlanId(planId)) !== null
    && supportingFilesArePreserved(
      inventoryPlanStorageDirectory(activeDirectory),
      inventoryPlanStorageDirectory(archiveDirectory)
    );
}

export function inspectPlanStorageConflict(roleDir: string, planId: string): PlanStorageConflictInspection {
  const id = canonicalLogicalPlanId(planId);
  const activePath = planStorageDirectory(roleDir, id, "active");
  const archivePath = planStorageDirectory(roleDir, id, "archive");
  const validatePhysicalDirectory = (directory: string, bucket: string): boolean => {
    if (!fs.existsSync(directory)) return false;
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${bucket}_storage_is_not_a_canonical_directory`);
    if (!fs.existsSync(path.join(directory, PLAN_FILE))) throw new Error(`${bucket}_directory_is_missing_plan_json`);
    return true;
  };
  let activeExists: boolean;
  let archiveExists: boolean;
  try {
    activeExists = validatePhysicalDirectory(activePath, "active");
    archiveExists = validatePhysicalDirectory(archivePath, "archive");
  } catch (error) {
    return { planId: id, status: "conflict", reason: error instanceof Error ? error.message : String(error), activePath, archivePath };
  }
  if (!activeExists && !archiveExists) return { planId: id, status: "absent", reason: "no_plan", activePath, archivePath };
  if (!activeExists || !archiveExists) return { planId: id, status: "single", reason: "single_canonical_bucket", activePath, archivePath };
  try {
    const activeInventory = inventoryPlanStorageDirectory(activePath);
    const archiveInventory = inventoryPlanStorageDirectory(archivePath);
    const dominanceReason = planLineageDominanceReason(activePath, archivePath, id);
    const dominated = dominanceReason !== null && supportingFilesArePreserved(activeInventory, archiveInventory);
    return {
      planId: id,
      status: dominated ? "reconcilable" : "conflict",
      reason: dominated ? dominanceReason! : "active_and_archive_are_not_a_proven_dominated_lineage",
      activePath,
      archivePath,
      activeInventory,
      archiveInventory
    };
  } catch (error) {
    return { planId: id, status: "conflict", reason: error instanceof Error ? error.message : String(error), activePath, archivePath };
  }
}
