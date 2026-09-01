import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalLogicalPlanId, canonicalPlanStorageKey } from "./planStorageIdentity.js";
import {
  validateCanonicalActivePlanDirectory,
  validateCanonicalArchivedPlanDirectory
} from "./planStoragePolicy.js";
import {
  MAX_PERSONA_SYNC_PLAN_PACKAGE_BYTES,
  MAX_PERSONA_SYNC_PLAN_PACKAGE_FILE_BYTES,
  MAX_PERSONA_SYNC_PLAN_PACKAGE_FILES,
  canonicalPersonaSyncPlanPackageInventory,
  canonicalPersonaSyncPlanPackagePath,
  encodePersonaSyncPlanPackageV1,
  personaSyncPlanPackageInventoryHash,
  type PersonaSyncActivePlanPackageCommand,
  type PersonaSyncArchivedPlanPackageCommand,
  type PersonaSyncPlanPackageBucket,
  type PersonaSyncPlanPackageFile,
  type PersonaSyncPlanPackageInventoryEntry
} from "./personaSyncPlanPackageV1Codec.js";

export {
  MAX_PERSONA_SYNC_PLAN_PACKAGE_BYTES,
  MAX_PERSONA_SYNC_PLAN_PACKAGE_FILE_BYTES,
  MAX_PERSONA_SYNC_PLAN_PACKAGE_FILES,
  PERSONA_SYNC_PLAN_PACKAGE_CAPABILITY
} from "./personaSyncPlanPackageV1Codec.js";
export type {
  PersonaSyncActivePlanPackageCommand,
  PersonaSyncArchivedPlanPackageCommand,
  PersonaSyncPlanPackageFile
} from "./personaSyncPlanPackageV1Codec.js";
export {
  applyActivePlanPackage,
  applyArchivedPlanPackage,
  recoverPersonaSyncPlanPackageTransactions
} from "./planStoragePackageImport.js";
export type {
  PersonaSyncPlanPackageRecoveryReport,
  PersonaSyncPlanPackageResult
} from "./planStoragePackageImport.js";

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function archivedPlanPackageInventoryHash(
  entries: readonly PersonaSyncPlanPackageInventoryEntry[]
): string {
  return personaSyncPlanPackageInventoryHash(entries);
}

/**
 * Produces a stable, portable inventory for read-only sync preview/encoding.
 * It never selects a destination or mutates plan storage.
 */
export function archivedPlanPackageInventory(directory: string): {
  hash: string;
  files: PersonaSyncPlanPackageInventoryEntry[];
} {
  const root = path.resolve(directory);
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Persona sync plan package root must be one canonical directory.");
  }
  const files: PersonaSyncPlanPackageInventoryEntry[] = [];
  let total = 0;
  const visit = (current: string, relative = ""): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const child = canonicalPersonaSyncPlanPackagePath(relative ? `${relative}/${entry.name}` : entry.name);
      const target = path.join(current, entry.name);
      const before = fs.lstatSync(target);
      if (before.isSymbolicLink()) {
        throw new Error(`Persona sync plan package contains a symbolic link or junction: ${child}`);
      }
      if (entry.isDirectory()) {
        if (!before.isDirectory()) throw new Error(`Persona sync plan package entry changed while scanning: ${child}`);
        visit(target, child);
        continue;
      }
      if (!entry.isFile() || !before.isFile()) {
        throw new Error(`Persona sync plan package contains an unsupported entry: ${child}`);
      }
      if (before.size > MAX_PERSONA_SYNC_PLAN_PACKAGE_FILE_BYTES) {
        throw new Error(`Persona sync plan package file is too large: ${child}`);
      }
      total += before.size;
      if (files.length + 1 > MAX_PERSONA_SYNC_PLAN_PACKAGE_FILES || total > MAX_PERSONA_SYNC_PLAN_PACKAGE_BYTES) {
        throw new Error("Persona sync plan package exceeds its physical inventory limits.");
      }
      const content = fs.readFileSync(target);
      const after = fs.lstatSync(target);
      if (after.isSymbolicLink() || !after.isFile() || after.size !== before.size
        || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
        throw new Error(`Persona sync plan package file changed while scanning: ${child}`);
      }
      files.push({ path: child, size: content.byteLength, sha256: sha256(content) });
    }
  };
  visit(root);
  const canonical = canonicalPersonaSyncPlanPackageInventory(files);
  return { hash: personaSyncPlanPackageInventoryHash(canonical), files: canonical };
}

function createPlanPackageCommandFromFiles(
  roleId: string,
  planId: string,
  files: readonly PersonaSyncPlanPackageFile[],
  _bucket: PersonaSyncPlanPackageBucket,
  peerId?: string
): PersonaSyncArchivedPlanPackageCommand {
  const id = canonicalLogicalPlanId(planId);
  return encodePersonaSyncPlanPackageV1({
    roleId,
    planId: id,
    storageId: canonicalPlanStorageKey(id),
    files,
    peerId
  });
}

export function createArchivedPlanPackageCommandFromFiles(
  roleId: string,
  planId: string,
  files: readonly PersonaSyncPlanPackageFile[],
  peerId?: string
): PersonaSyncArchivedPlanPackageCommand {
  return createPlanPackageCommandFromFiles(roleId, planId, files, "archive", peerId);
}

export function createActivePlanPackageCommandFromFiles(
  roleId: string,
  planId: string,
  files: readonly PersonaSyncPlanPackageFile[],
  peerId?: string
): PersonaSyncActivePlanPackageCommand {
  return createPlanPackageCommandFromFiles(roleId, planId, files, "active", peerId);
}

function assertCanonicalSourceDirectory(
  directory: string,
  planId: string,
  bucket: PersonaSyncPlanPackageBucket
): string {
  const resolved = path.resolve(directory);
  if (path.basename(resolved) !== canonicalPlanStorageKey(planId) || path.basename(path.dirname(resolved)) !== bucket) {
    throw new Error(`Persona sync ${bucket} package source is not its canonical plan directory.`);
  }
  return resolved;
}

function createPlanPackageCommand(
  roleId: string,
  planId: string,
  directory: string,
  bucket: PersonaSyncPlanPackageBucket,
  peerId?: string
): PersonaSyncArchivedPlanPackageCommand {
  const id = canonicalLogicalPlanId(planId);
  const source = assertCanonicalSourceDirectory(directory, id, bucket);
  if (bucket === "archive") validateCanonicalArchivedPlanDirectory(source, id);
  else validateCanonicalActivePlanDirectory(source, id);
  const before = archivedPlanPackageInventory(source);
  const files = before.files.map(file => {
    const content = fs.readFileSync(path.join(source, ...file.path.split("/")));
    if (content.byteLength !== file.size || sha256(content) !== file.sha256) {
      throw new Error(`Persona sync plan package changed while being serialized: ${file.path}`);
    }
    return { ...file, contentBase64: content.toString("base64") };
  });
  if (bucket === "archive") validateCanonicalArchivedPlanDirectory(source, id);
  else validateCanonicalActivePlanDirectory(source, id);
  const after = archivedPlanPackageInventory(source);
  if (after.hash !== before.hash) throw new Error("Persona sync plan package changed while being serialized.");
  return createPlanPackageCommandFromFiles(roleId, id, files, bucket, peerId);
}

export function createArchivedPlanPackageCommand(
  roleId: string,
  planId: string,
  archiveDirectory: string,
  peerId?: string
): PersonaSyncArchivedPlanPackageCommand {
  return createPlanPackageCommand(roleId, planId, archiveDirectory, "archive", peerId);
}

export function createActivePlanPackageCommand(
  roleId: string,
  planId: string,
  activeDirectory: string,
  peerId?: string
): PersonaSyncActivePlanPackageCommand {
  return createPlanPackageCommand(roleId, planId, activeDirectory, "active", peerId);
}
