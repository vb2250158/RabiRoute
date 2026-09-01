import { createHash } from "node:crypto";
import {
  canonicalLogicalPlanId,
  canonicalPlanStorageKey,
  windowsPlanStoragePathCollisionKey
} from "./planStorageIdentity.js";

export const PERSONA_SYNC_PLAN_PACKAGE_CAPABILITY = "persona-sync-plan-package-v1";
export const MAX_PERSONA_SYNC_PLAN_PACKAGE_BYTES = 96 * 1024 * 1024;
export const MAX_PERSONA_SYNC_PLAN_PACKAGE_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_PERSONA_SYNC_PLAN_PACKAGE_FILES = 4_096;

export type PersonaSyncPlanPackageBucket = "active" | "archive";

export type PersonaSyncPlanPackageFile = {
  path: string;
  size: number;
  sha256: string;
  contentBase64: string;
};

export type PersonaSyncArchivedPlanPackageCommand = {
  schemaVersion: 1;
  roleId: string;
  planId: string;
  storageId: string;
  inventoryHash: string;
  files: PersonaSyncPlanPackageFile[];
  peerId?: string;
};

export type PersonaSyncActivePlanPackageCommand = PersonaSyncArchivedPlanPackageCommand;

export type PersonaSyncPlanPackageInventoryEntry = {
  path: string;
  size: number;
  sha256: string;
};

export type DecodedPersonaSyncPlanPackageV1 = {
  roleId: string;
  planId: string;
  storageId: string;
  inventoryHash: string;
  files: Array<PersonaSyncPlanPackageInventoryEntry & { content: Buffer }>;
  peerId: string;
};

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const WINDOWS_FORBIDDEN_CHARACTER = /[<>:"|?*\u0000-\u001f\u007f]/u;
const PORTABLE_TRANSIENT_FILE = /\.(?:tmp|lock|part)$/i;
const MAX_PORTABLE_PATH_LENGTH = 1_000;
const MAX_PORTABLE_SEGMENT_LENGTH = 240;

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalRoleId(value: unknown): string {
  const raw = String(value || "");
  const roleId = raw.trim();
  if (!roleId || roleId !== raw || roleId.length > 200 || roleId.includes("/") || roleId.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(roleId)) {
    throw new Error("Persona sync plan package requires one canonical role id.");
  }
  return roleId;
}

export function canonicalPersonaSyncPlanPackagePath(value: unknown): string {
  const raw = String(value || "");
  if (!raw || raw !== raw.normalize("NFC") || raw.length > MAX_PORTABLE_PATH_LENGTH
    || raw.startsWith("/") || raw.startsWith("\\") || raw.includes("\\")
    || /^[a-z]:/i.test(raw) || raw.includes("//")) {
    throw new Error("Persona sync plan package file must use one canonical portable relative path.");
  }
  const segments = raw.split("/");
  if (segments.some(segment => {
    const lower = segment.toLocaleLowerCase("en-US");
    return !segment || segment === "." || segment === ".."
      || segment.startsWith(".") || lower === "tmp" || lower === "temp"
      || segment.length > MAX_PORTABLE_SEGMENT_LENGTH || segment.endsWith(" ") || segment.endsWith(".")
      || WINDOWS_FORBIDDEN_CHARACTER.test(segment) || WINDOWS_RESERVED_NAME.test(segment);
  })) {
    throw new Error(`Persona sync plan package contains a Windows-unsafe path: ${raw}`);
  }
  if (PORTABLE_TRANSIENT_FILE.test(raw)) {
    throw new Error(`Persona sync plan package contains a transient file: ${raw}`);
  }
  return raw;
}

function portablePathCollisionKey(value: string): string {
  return windowsPlanStoragePathCollisionKey(value);
}

export function canonicalPersonaSyncPlanPackageInventory(
  entries: readonly PersonaSyncPlanPackageInventoryEntry[]
): PersonaSyncPlanPackageInventoryEntry[] {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_PERSONA_SYNC_PLAN_PACKAGE_FILES) {
    throw new Error("Persona sync plan package has an invalid file count.");
  }
  const seen = new Set<string>();
  let total = 0;
  const canonical = entries.map(entry => {
    const relativePath = canonicalPersonaSyncPlanPackagePath(entry.path);
    const key = portablePathCollisionKey(relativePath);
    if (seen.has(key)) throw new Error(`Persona sync plan package contains a Windows path collision: ${relativePath}`);
    seen.add(key);
    const size = Number(entry.size);
    const fileHash = String(entry.sha256 || "").toLowerCase();
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_PERSONA_SYNC_PLAN_PACKAGE_FILE_BYTES
      || !/^[a-f0-9]{64}$/.test(fileHash)) {
      throw new Error(`Persona sync plan package has invalid inventory metadata: ${relativePath}`);
    }
    total += size;
    if (total > MAX_PERSONA_SYNC_PLAN_PACKAGE_BYTES) throw new Error("Persona sync plan package is too large.");
    return { path: relativePath, size, sha256: fileHash };
  });
  return canonical.sort((left, right) => left.path.localeCompare(right.path));
}

export function personaSyncPlanPackageInventoryHash(
  entries: readonly PersonaSyncPlanPackageInventoryEntry[]
): string {
  const canonical = canonicalPersonaSyncPlanPackageInventory(entries);
  return sha256(JSON.stringify(canonical.map(entry => [entry.path, entry.size, entry.sha256])));
}

function strictBase64(value: unknown, relativePath: string): Buffer {
  if (typeof value !== "string"
    || value.length > Math.ceil(MAX_PERSONA_SYNC_PLAN_PACKAGE_FILE_BYTES / 3) * 4
    || value.length % 4 !== 0
    || (value && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))) {
    throw new Error(`Persona sync plan package file has invalid base64: ${relativePath}`);
  }
  const content = Buffer.from(value, "base64");
  if (content.toString("base64") !== value) {
    throw new Error(`Persona sync plan package file has non-canonical base64: ${relativePath}`);
  }
  return content;
}

export function decodePersonaSyncPlanPackageV1(
  command: PersonaSyncArchivedPlanPackageCommand
): DecodedPersonaSyncPlanPackageV1 {
  if (command.schemaVersion !== 1) throw new Error("Unsupported persona sync plan package schema.");
  const roleId = canonicalRoleId(command.roleId);
  const planId = canonicalLogicalPlanId(command.planId);
  const storageId = String(command.storageId || "");
  if (storageId !== canonicalPlanStorageKey(planId)) {
    throw new Error("Persona sync plan package storage identity does not match its logical plan id.");
  }
  if (!Array.isArray(command.files) || command.files.length === 0
    || command.files.length > MAX_PERSONA_SYNC_PLAN_PACKAGE_FILES) {
    throw new Error("Persona sync plan package has an invalid file count.");
  }
  const decoded = command.files.map(file => {
    const relativePath = canonicalPersonaSyncPlanPackagePath(file.path);
    const content = strictBase64(file.contentBase64, relativePath);
    const fileHash = String(file.sha256 || "").toLowerCase();
    if (!Number.isSafeInteger(file.size) || file.size !== content.byteLength
      || content.byteLength > MAX_PERSONA_SYNC_PLAN_PACKAGE_FILE_BYTES
      || !/^[a-f0-9]{64}$/.test(fileHash) || sha256(content) !== fileHash) {
      throw new Error(`Persona sync plan package file integrity mismatch: ${relativePath}`);
    }
    return { path: relativePath, size: content.byteLength, sha256: fileHash, content };
  });
  const canonical = canonicalPersonaSyncPlanPackageInventory(decoded);
  const byPath = new Map(decoded.map(file => [file.path, file]));
  const files = canonical.map(entry => ({ ...entry, content: byPath.get(entry.path)!.content }));
  const inventoryHash = personaSyncPlanPackageInventoryHash(files);
  if (!/^[a-f0-9]{64}$/i.test(String(command.inventoryHash || ""))
    || inventoryHash !== String(command.inventoryHash).toLowerCase()) {
    throw new Error("Persona sync plan package inventory hash does not match its files.");
  }
  return {
    roleId,
    planId,
    storageId,
    inventoryHash,
    files,
    peerId: String(command.peerId || "")
  };
}

export function encodePersonaSyncPlanPackageV1(input: {
  roleId: string;
  planId: string;
  storageId: string;
  files: readonly PersonaSyncPlanPackageFile[];
  peerId?: string;
}): PersonaSyncArchivedPlanPackageCommand {
  const planId = canonicalLogicalPlanId(input.planId);
  const storageId = String(input.storageId || "");
  if (storageId !== canonicalPlanStorageKey(planId)) {
    throw new Error("Persona sync plan package storage identity does not match its logical plan id.");
  }
  const files = input.files.map(file => ({
    path: canonicalPersonaSyncPlanPackagePath(file.path),
    size: Number(file.size),
    sha256: String(file.sha256 || "").toLowerCase(),
    contentBase64: String(file.contentBase64 ?? "")
  }));
  const command: PersonaSyncArchivedPlanPackageCommand = {
    schemaVersion: 1,
    roleId: canonicalRoleId(input.roleId),
    planId,
    storageId,
    inventoryHash: personaSyncPlanPackageInventoryHash(files),
    files,
    ...(input.peerId === undefined ? {} : { peerId: input.peerId })
  };
  decodePersonaSyncPlanPackageV1(command);
  return command;
}
