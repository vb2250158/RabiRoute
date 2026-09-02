import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "./shared/filePersistence.js";
import {
  canonicalHistoricalPlanStorageCollisionKey,
  canonicalLogicalPlanId,
  canonicalPlanStorageCollisionKey,
  canonicalPlanStorageKey,
  windowsPlanStoragePathCollisionKey
} from "./planStorageIdentity.js";
import {
  assertPlanStorageLeaseOwner,
  planStorageLeasePath,
  requireCurrentPlanStorageLease,
  withPlanStorageLease,
  withPlanStorageLeaseAsync,
  type PlanStorageLease
} from "./plan-storage/internal/lease.js";

export {
  assertPlanStorageLeaseOwner,
  planStorageLeasePath,
  requireCurrentPlanStorageLease,
  withPlanStorageLease,
  withPlanStorageLeaseAsync
} from "./plan-storage/internal/lease.js";
export type { PlanStorageLease } from "./plan-storage/internal/lease.js";

export type PlanStorageBucket = "active" | "archive";

export type PlanStorageInventoryEntry = {
  path: string;
  bytes: number;
  modifiedAt: string;
  sha256: string;
};

export type PlanStorageInventory = {
  hash: string;
  files: PlanStorageInventoryEntry[];
};

export type PlanStorageDirectoryMoveState = "source" | "destination" | "conflict" | "missing";

export type PlanStoragePackageFile = {
  path: string;
  size: number;
  sha256: string;
  content: Buffer;
};

export type CommitPlanStoragePackageInput = {
  roleDir: string;
  planId: string;
  storageId: string;
  bucket: PlanStorageBucket;
  inventoryHash: string;
  files: PlanStoragePackageFile[];
  transactionId: string;
  archiveDominatesActive?: (activeDirectory: string, stagedArchiveDirectory: string, planId: string) => boolean;
};

export type PlanStoragePackageCommitResult = {
  status: "applied" | "unchanged" | "conflict";
  reason?: string;
  currentInventoryHash?: string;
  quarantinePath?: string;
  receiptPath?: string;
};

export type PlanStoragePackageRecoveryResult = {
  results: Array<PlanStoragePackageCommitResult & {
    planId: string;
    storageId: string;
    bucket: PlanStorageBucket;
    inventoryHash: string;
  }>;
  failures: Array<{ transactionPath: string; error: string }>;
};

export type ReadPlanStoragePackageResult = {
  roleDir: string;
  planId: string;
  storageId: string;
  bucket: PlanStorageBucket;
  inventoryHash: string;
  files: PlanStoragePackageFile[];
};

export type PlanStorageTransactionFile = { relativePath: string; content: Buffer };

export type PlanStorageTransactionOperation =
  | { type: "publish-directory"; relativePath: string; files: PlanStorageTransactionFile[] }
  | { type: "replace-file"; relativePath: string; content: Buffer };

export type PlanStorageTransactionHooks = {
  afterPayloadWrite?: (operationIndex: number, relativePath: string) => void;
  afterOperation?: (operationIndex: number, operation: PlanStorageTransactionOperation["type"]) => void;
};

export type PlanStorageTransactionSpec = {
  transactionId: string;
  kind: "plan-feedback" | "plan-feedback-revision";
  /** Stable business identity; retries may carry different generated timestamps. */
  semanticHash?: string;
  operations: PlanStorageTransactionOperation[];
  hooks?: PlanStorageTransactionHooks;
};

export type PlanStorageTransactionCommitResult = {
  status: "committed" | "already_committed";
  receiptPath: string;
};

export type PlanStorageTransactionRecoveryResult = {
  committed: number;
  alreadyCommitted: number;
  failures: Array<{ transactionPath: string; error: string }>;
};

export type PlanStorageCommitEvent = {
  kind: "package" | "plan-feedback" | "plan-feedback-revision" | PlanStorageLifecycleKind;
  roleDir: string;
  planId: string;
  storageId: string;
  bucket: PlanStorageBucket;
  transactionId: string;
  changedPaths: string[];
  committedAt: string;
};

export type PlanStorageLegacyResolutionStatus = "duplicate_retired" | "conflict_quarantined";

export type PlanStorageLegacyArtifact = {
  sourcePath: string;
  evidenceRelativePath: string;
  kind: "file" | "directory";
  expectedHash: string;
};

export type CommitPlanStorageLegacyResolutionInput = {
  transactionId: string;
  status: PlanStorageLegacyResolutionStatus;
  canonicalDirectory: string;
  canonicalInventoryHash: string;
  legacyInventoryHash: string;
  artifacts: PlanStorageLegacyArtifact[];
};

export type PlanStorageLegacyResolutionResult = {
  status: PlanStorageLegacyResolutionStatus;
  receiptPath: string;
  evidenceDirectory: string;
  recovered: boolean;
};

export type PlanStorageLegacyRecoveryResult = {
  results: PlanStorageLegacyResolutionResult[];
  failures: Array<{ transactionPath: string; error: string }>;
};

export type PlanStorageLifecycleKind = "plan-create" | "plan-update" | "plan-archive";

export type CommitPlanLifecycleTransitionInput = {
  transactionId: string;
  kind: PlanStorageLifecycleKind;
  fromBucket: PlanStorageBucket | null;
  toBucket: PlanStorageBucket;
  expectedSourceInventoryHash?: string;
  files: PlanStoragePackageFile[];
};

export type PlanStorageLifecycleTransitionResult = {
  status: "committed" | "already_committed";
  receiptPath: string;
  previousDirectory?: string;
  bucket: PlanStorageBucket;
  inventoryHash: string;
};

export type PlanStorageLifecycleRecoveryResult = {
  results: PlanStorageLifecycleTransitionResult[];
  failures: Array<{ transactionPath: string; error: string }>;
};

type StoredTransactionOperation =
  | { type: "publish-directory"; relativePath: string; files: Array<{ relativePath: string; size: number; sha256: string }> }
  | { type: "replace-file"; relativePath: string; size: number; sha256: string };

type StoredPlanStorageTransaction = {
  schemaVersion: 1;
  kind: "plan_storage_repository_transaction";
  status: "prepared";
  transactionKind: "plan-feedback" | "plan-feedback-revision";
  transactionId: string;
  roleDir: string;
  planId: string;
  storageId: string;
  bucket: PlanStorageBucket;
  specHash: string;
  semanticHash?: string;
  operations: StoredTransactionOperation[];
  preparedAt: string;
};

type PackageTransactionReceipt = {
  schemaVersion: 1;
  kind: "plan_storage_package_commit";
  status: "applied" | "conflict";
  transactionId: string;
  planId: string;
  storageId: string;
  bucket: PlanStorageBucket;
  inventoryHash: string;
  specHash: string;
  reason?: string;
  currentInventoryHash?: string;
  quarantinePath?: string;
  committedAt: string;
};

const MAX_PACKAGE_FILES = 4_096;
const MAX_PACKAGE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 96 * 1024 * 1024;
const commitListeners = new Set<(event: PlanStorageCommitEvent) => void>();
const beforeMutationListeners = new Set<(event: Pick<PlanStorageCommitEvent, "roleDir" | "planId" | "storageId">) => void>();

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function plansRoot(roleDir: string): string {
  return path.join(roleDir, "plans");
}

function canonicalPlanDirectory(roleDir: string, planId: string, bucket: PlanStorageBucket): string {
  return path.join(plansRoot(roleDir), bucket, canonicalPlanStorageKey(planId));
}

function matchesPlanStorageCollision(entryName: string, collisionId: string): boolean {
  return windowsPlanStoragePathCollisionKey(entryName) === collisionId
    || canonicalHistoricalPlanStorageCollisionKey(entryName) === collisionId;
}

function fixedDepthTransactionManifests(root: string, directoryDepth: number): string[] {
  let directories = [path.resolve(root)];
  for (let depth = 0; depth < directoryDepth; depth += 1) {
    const next: string[] = [];
    for (const directory of directories) {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        const target = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Plan storage transaction root contains a link: ${target}`);
        if (entry.isDirectory()) next.push(target);
      }
    }
    directories = next;
  }
  return directories.flatMap(directory => {
    const manifestPath = path.join(directory, "manifest.json");
    try {
      const stat = fs.lstatSync(manifestPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`Plan storage transaction manifest is not one plain file: ${manifestPath}`);
      }
      return [manifestPath];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }).sort((left, right) => left.localeCompare(right));
}

function relativePlanPath(filePath: string, root: string): string {
  return path.relative(root, filePath).replace(/\\/g, "/");
}

export function inventoryPlanStorageDirectory(
  directory: string,
  lease?: PlanStorageLease
): PlanStorageInventory {
  const root = path.resolve(directory);
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Plan storage inventory root is not one plain directory: ${root}`);
  }
  const files: PlanStorageInventoryEntry[] = [];
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (lease) assertPlanStorageLeaseOwner(lease);
      const target = path.join(current, entry.name);
      const before = fs.lstatSync(target);
      if (before.isSymbolicLink()) throw new Error(`Plan storage contains a symbolic link or junction: ${target}`);
      if (entry.isDirectory()) {
        if (!before.isDirectory()) throw new Error(`Plan storage entry changed during inventory: ${target}`);
        visit(target);
        continue;
      }
      if (!entry.isFile() || !before.isFile()) throw new Error(`Plan storage contains an unsupported entry: ${target}`);
      const content = fs.readFileSync(target);
      const after = fs.lstatSync(target);
      if (after.isSymbolicLink() || !after.isFile() || after.size !== before.size
        || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
        throw new Error(`Plan storage entry changed during inventory: ${target}`);
      }
      files.push({
        path: relativePlanPath(target, root),
        bytes: content.byteLength,
        modifiedAt: after.mtime.toISOString(),
        sha256: sha256(content)
      });
    }
  };
  visit(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  const identity = files.map(({ path: filePath, bytes, sha256: fileHash }) => [filePath, bytes, fileHash]);
  return { hash: sha256(JSON.stringify(identity)), files };
}

export function exactPlanStorageDirectoryExists(parent: string, name: string): boolean {
  try {
    const entry = fs.readdirSync(parent, { withFileTypes: true }).find((candidate) => candidate.name === name);
    return Boolean(entry?.isDirectory() && !entry.isSymbolicLink());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function inspectPlanStorageDirectoryMove(sourcePath: string, destinationPath: string): PlanStorageDirectoryMoveState {
  const source = exactPlanStorageDirectoryExists(path.dirname(sourcePath), path.basename(sourcePath));
  const destination = exactPlanStorageDirectoryExists(path.dirname(destinationPath), path.basename(destinationPath));
  if (source && destination) return "conflict";
  if (source) return "source";
  if (destination) return "destination";
  return "missing";
}

export function publishPlanStorageDirectoryUnderLease(
  lease: PlanStorageLease,
  sourcePath: string,
  destinationPath: string
): void {
  assertPlanStorageLeaseOwner(lease);
  notifyBeforePlanStorageMutation(lease);
  const state = inspectPlanStorageDirectoryMove(sourcePath, destinationPath);
  if (state !== "source") {
    throw new Error(`Plan storage directory publish requires source-only state, received ${state}: ${sourcePath} -> ${destinationPath}`);
  }
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.renameSync(sourcePath, destinationPath);
  assertPlanStorageLeaseOwner(lease);
  if (inspectPlanStorageDirectoryMove(sourcePath, destinationPath) !== "destination") {
    throw new Error(`Plan storage directory publish did not reach destination-only state: ${destinationPath}`);
  }
}

export function moveCanonicalPlanStorageDirectoryUnderLease(
  lease: PlanStorageLease,
  fromBucket: PlanStorageBucket,
  toBucket: PlanStorageBucket
): string {
  const source = canonicalPlanDirectory(lease.roleDir, lease.planId, fromBucket);
  const destination = canonicalPlanDirectory(lease.roleDir, lease.planId, toBucket);
  publishPlanStorageDirectoryUnderLease(lease, source, destination);
  return destination;
}

export type CanonicalPlanStorageLocation = {
  roleDir: string;
  planId: string;
  storageId: string;
  bucket: PlanStorageBucket;
  directory: string;
  planFile: string;
};

export function readCanonicalPlanJsonUnderLease(lease: PlanStorageLease): Record<string, unknown> {
  assertPlanStorageLeaseOwner(lease);
  const location = resolveCanonicalPlanStorageLocation(lease.roleDir, lease.planId);
  if (!location) throw new Error(`Canonical plan storage does not exist: ${lease.planId}`);
  const value = JSON.parse(fs.readFileSync(location.planFile, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Canonical plan.json must contain an object: ${location.planFile}`);
  }
  const record = value as Record<string, unknown>;
  if (canonicalLogicalPlanId(record.id) !== lease.planId) {
    throw new Error(`Canonical plan identity changed while its lease was held: ${lease.planId}`);
  }
  assertPlanStorageLeaseOwner(lease);
  return record;
}

export function resolveCanonicalPlanStorageLocation(
  roleDir: string,
  planId: string
): CanonicalPlanStorageLocation | null {
  const logicalPlanId = canonicalLogicalPlanId(planId);
  const storageId = canonicalPlanStorageKey(logicalPlanId);
  const collisionId = canonicalPlanStorageCollisionKey(logicalPlanId);
  const matches: CanonicalPlanStorageLocation[] = [];
  for (const bucket of ["active", "archive"] as const) {
    const root = path.join(plansRoot(roleDir), bucket);
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const entry of entries) {
      if (entry.name.toLocaleLowerCase("en-US").endsWith(".json")) continue;
      if (!matchesPlanStorageCollision(entry.name, collisionId)) continue;
      const directory = path.join(root, entry.name);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error(`Plan storage identity is occupied by a non-directory entry: ${directory}`);
      }
      const planFile = path.join(directory, "plan.json");
      if (!fs.existsSync(planFile)) throw new Error(`Plan storage directory is missing plan.json: ${directory}`);
      const plan = JSON.parse(fs.readFileSync(planFile, "utf8")) as { id?: unknown; status?: unknown };
      const storedPlanId = canonicalLogicalPlanId(plan.id);
      if (canonicalPlanStorageCollisionKey(storedPlanId) !== collisionId || storedPlanId !== logicalPlanId) {
        throw new Error(`Plan storage identity collision: ${logicalPlanId} is owned by ${storedPlanId}`);
      }
      if (canonicalPlanStorageKey(storedPlanId) !== entry.name || entry.name !== storageId) {
        throw new Error(`Plan storage identity requires canonical case/NFC migration: ${directory}`);
      }
      const expectedBucket: PlanStorageBucket = plan.status === "已归档" ? "archive" : "active";
      if (expectedBucket !== bucket) throw new Error(`Plan storage bucket does not match plan status: ${directory}`);
      matches.push({ roleDir: path.resolve(roleDir), planId: logicalPlanId, storageId, bucket, directory, planFile });
    }
  }
  if (matches.length > 1) throw new Error(`Plan storage identity collision across active/archive: ${logicalPlanId}`);
  return matches[0] ?? null;
}

export function assertPlanStorageIdentityAvailable(roleDir: string, planId: string): void {
  const location = resolveCanonicalPlanStorageLocation(roleDir, planId);
  if (location) throw new Error(`Plan storage identity is already occupied: ${location.directory}`);
}

function canonicalRelativePath(value: unknown): string {
  const raw = String(value || "");
  if (!raw || raw !== raw.normalize("NFC") || raw.startsWith("/") || raw.startsWith("\\")
    || raw.includes("\\") || /^[a-z]:/i.test(raw) || raw.includes("//")) {
    throw new Error(`Plan storage transaction path is not canonical: ${raw}`);
  }
  const segments = raw.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".."
    || segment.startsWith(".") || /[<>:"|?*\u0000-\u001f\u007f]/u.test(segment)
    || segment.endsWith(" ") || segment.endsWith("."))) {
    throw new Error(`Plan storage transaction path is unsafe: ${raw}`);
  }
  return segments.join("/");
}

function assertPlainAncestors(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Plan storage transaction escaped its canonical plan directory: ${target}`);
  }
  let current = path.resolve(root);
  for (const segment of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Plan storage transaction encountered a non-plain ancestor: ${current}`);
    }
  }
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    throw new Error(`Plan storage transaction target is a symbolic link or junction: ${target}`);
  }
}

function canonicalPackageFiles(files: PlanStoragePackageFile[]): PlanStoragePackageFile[] {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_PACKAGE_FILES) {
    throw new Error("Plan storage package has an invalid file count.");
  }
  const keys = new Set<string>();
  let total = 0;
  const canonical = files.map((file) => {
    const relativePath = canonicalRelativePath(file.path);
    const key = windowsPlanStoragePathCollisionKey(relativePath);
    if (keys.has(key)) throw new Error(`Plan storage package has a Windows path collision: ${relativePath}`);
    keys.add(key);
    const content = Buffer.from(file.content);
    const size = Number(file.size);
    const contentHash = sha256(content);
    if (!Number.isSafeInteger(size) || size !== content.byteLength || size > MAX_PACKAGE_FILE_BYTES
      || String(file.sha256 || "").toLocaleLowerCase("en-US") !== contentHash) {
      throw new Error(`Plan storage package file metadata does not match its bytes: ${relativePath}`);
    }
    total += size;
    if (total > MAX_PACKAGE_BYTES) throw new Error("Plan storage package is too large.");
    return { path: relativePath, size, sha256: contentHash, content };
  });
  return canonical.sort((a, b) => a.path.localeCompare(b.path));
}

function packageInventoryHash(files: Array<Pick<PlanStoragePackageFile, "path" | "size" | "sha256">>): string {
  return sha256(JSON.stringify(files.map((file) => [file.path, file.size, file.sha256])));
}

function validatePackageIdentity(planId: string, bucket: PlanStorageBucket, files: PlanStoragePackageFile[]): void {
  const byPath = new Map(files.map((file) => [file.path, file.content]));
  const planBytes = byPath.get("plan.json");
  const historyBytes = byPath.get("history.jsonl");
  if (!planBytes || !historyBytes) throw new Error("Plan storage package requires plan.json and history.jsonl.");
  const plan = JSON.parse(planBytes.toString("utf8")) as { id?: unknown; status?: unknown };
  if (canonicalLogicalPlanId(plan.id) !== planId) throw new Error("Plan storage package plan.json identity mismatch.");
  if ((bucket === "archive") !== (plan.status === "已归档")) {
    throw new Error("Plan storage package bucket does not match plan status.");
  }
  const historyLines = historyBytes.toString("utf8").split(/\r?\n/).filter(Boolean);
  if (!historyLines.length) throw new Error("Plan storage package requires non-empty history.");
  for (const line of historyLines) {
    const record = JSON.parse(line) as { id?: unknown; planId?: unknown };
    if (typeof record.id !== "string" || record.planId !== planId) {
      throw new Error("Plan storage package history identity mismatch.");
    }
  }
}

function physicalPackageInventory(directory: string): { hash: string; files: PlanStoragePackageFile[] } {
  const inventory = inventoryPlanStorageDirectory(directory);
  const files = inventory.files.map((entry) => {
    const content = fs.readFileSync(path.join(directory, ...entry.path.split("/")));
    return { path: entry.path, size: entry.bytes, sha256: entry.sha256, content };
  });
  return { hash: packageInventoryHash(files), files };
}

function packageSpecHash(input: CommitPlanStoragePackageInput, files: PlanStoragePackageFile[]): string {
  return sha256(JSON.stringify({
    planId: input.planId,
    storageId: input.storageId,
    bucket: input.bucket,
    inventoryHash: input.inventoryHash,
    files: files.map(({ path: filePath, size, sha256: fileHash }) => [filePath, size, fileHash])
  }));
}

function packageTransactionRoot(input: CommitPlanStoragePackageInput): string {
  return path.join(plansRoot(input.roleDir), "quarantine", "plan-storage-package-transactions", input.storageId, input.transactionId);
}

function packageReceiptPath(input: CommitPlanStoragePackageInput): string {
  return path.join(plansRoot(input.roleDir), "quarantine", "plan-storage-package-receipts", input.storageId, `${input.transactionId}.json`);
}

function ensurePackagePayloadUnderLease(
  lease: PlanStorageLease,
  transactionRoot: string,
  files: PlanStoragePackageFile[],
  inventoryHash: string
): string {
  const payload = path.join(transactionRoot, "payload");
  if (fs.existsSync(payload)) {
    try {
      if (physicalPackageInventory(payload).hash === inventoryHash) return payload;
    } catch {
      // Preserve an incomplete/corrupt stage below before publishing the complete candidate.
    }
  }
  const candidate = path.join(transactionRoot, `.payload.${randomUUID()}.candidate`);
  fs.mkdirSync(candidate, { recursive: false });
  for (const file of files) {
    assertPlanStorageLeaseOwner(lease);
    atomicWriteFileSync(path.join(candidate, ...file.path.split("/")), file.content);
  }
  const staged = physicalPackageInventory(candidate);
  if (staged.hash !== inventoryHash) throw new Error("Plan storage package candidate inventory changed while staging.");
  assertPlanStorageLeaseOwner(lease);
  if (fs.existsSync(payload)) {
    const incomplete = path.join(transactionRoot, `payload.incomplete.${randomUUID()}`);
    publishPlanStorageDirectoryUnderLease(lease, payload, incomplete);
  }
  publishPlanStorageDirectoryUnderLease(lease, candidate, payload);
  return payload;
}

export function claimPlanStorageIdentity(lease: PlanStorageLease): void {
  assertPlanStorageLeaseOwner(lease);
  const collisionId = canonicalPlanStorageCollisionKey(lease.planId);
  for (const bucket of ["active", "archive"] as const) {
    const bucketRoot = path.join(plansRoot(lease.roleDir), bucket);
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(bucketRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const entry of entries) {
      if (!matchesPlanStorageCollision(entry.name, collisionId)) continue;
      const directory = path.join(bucketRoot, entry.name);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error(`Plan storage identity collision: ${lease.planId} is occupied by ${entry.name}`);
      }
      try {
        const owner = canonicalLogicalPlanId(
          (JSON.parse(fs.readFileSync(path.join(directory, "plan.json"), "utf8")) as { id?: unknown }).id
        );
        if (canonicalPlanStorageCollisionKey(owner) !== collisionId || owner !== lease.planId) {
          throw new Error(`Plan storage identity collision: ${lease.planId} is owned by ${owner}`);
        }
      } catch (error) {
        if (error instanceof Error && /identity collision/i.test(error.message)) throw error;
        throw new Error(`Plan storage identity collision: ${lease.planId} is occupied by invalid storage ${entry.name}`);
      }
    }
  }
  const identityRoot = path.join(plansRoot(lease.roleDir), ".identity");
  let claims: fs.Dirent[] = [];
  try {
    claims = fs.readdirSync(identityRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const entry of claims) {
    if (!entry.name.toLocaleLowerCase("en-US").endsWith(".json")) continue;
    const claimedStorageId = entry.name.slice(0, -".json".length);
    if (!matchesPlanStorageCollision(claimedStorageId, collisionId)) continue;
    const claimPath = path.join(identityRoot, entry.name);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`Plan storage identity collision: ${lease.planId} has an invalid claim`);
    }
    let existing: { planId?: unknown; storageId?: unknown };
    let owner: string;
    try {
      existing = JSON.parse(fs.readFileSync(claimPath, "utf8")) as { planId?: unknown; storageId?: unknown };
      owner = canonicalLogicalPlanId(existing.planId);
    } catch {
      throw new Error(`Plan storage identity collision: ${lease.planId} has an unreadable claim`);
    }
    if (canonicalPlanStorageCollisionKey(owner) !== collisionId
      || owner !== lease.planId
      || existing.storageId !== canonicalPlanStorageKey(owner)) {
      throw new Error(`Plan storage identity collision: ${lease.planId} is owned by ${owner}`);
    }
  }
  const identityPath = path.join(plansRoot(lease.roleDir), ".identity", `${lease.storageId}.json`);
  try {
    const existing = JSON.parse(fs.readFileSync(identityPath, "utf8")) as { planId?: unknown; storageId?: unknown };
    const owner = canonicalLogicalPlanId(existing.planId);
    if (existing.storageId !== lease.storageId || owner !== lease.planId) {
      throw new Error(`Plan storage identity collision: ${lease.planId} is owned by ${owner}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    atomicWriteFileSync(identityPath, `${JSON.stringify({
      schemaVersion: 1,
      planId: lease.planId,
      storageId: lease.storageId,
      claimedAt: new Date().toISOString()
    }, null, 2)}\n`);
  }
  assertPlanStorageLeaseOwner(lease);
}

function readPackageReceipt(filePath: string): PackageTransactionReceipt | null {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as PackageTransactionReceipt;
    return value?.schemaVersion === 1 && value.kind === "plan_storage_package_commit" ? value : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function emitCommit(event: PlanStorageCommitEvent): void {
  for (const listener of commitListeners) {
    try {
      listener(event);
    } catch {
      // Storage commit durability cannot depend on an in-process observer.
    }
  }
}

function notifyBeforePlanStorageMutation(lease: PlanStorageLease): void {
  assertPlanStorageLeaseOwner(lease);
  const event = { roleDir: lease.roleDir, planId: lease.planId, storageId: lease.storageId };
  for (const listener of beforeMutationListeners) listener(event);
  assertPlanStorageLeaseOwner(lease);
}

export function subscribePlanStorageBeforeMutation(
  listener: (event: Pick<PlanStorageCommitEvent, "roleDir" | "planId" | "storageId">) => void
): () => void {
  beforeMutationListeners.add(listener);
  return () => beforeMutationListeners.delete(listener);
}

export function subscribePlanStorageCommits(listener: (event: PlanStorageCommitEvent) => void): () => void {
  commitListeners.add(listener);
  return () => commitListeners.delete(listener);
}

export const subscribePlanStorageChanges = subscribePlanStorageCommits;

type StoredPlanStorageLegacyResolution = CommitPlanStorageLegacyResolutionInput & {
  schemaVersion: 1;
  kind: "plan_storage_legacy_resolution";
  roleDir: string;
  planId: string;
  storageId: string;
  preparedAt: string;
};

function legacyResolutionRoot(lease: PlanStorageLease, transactionId: string): string {
  return path.join(
    plansRoot(lease.roleDir),
    "quarantine",
    "plan-storage-legacy-resolutions",
    lease.storageId,
    transactionId
  );
}

function assertPathWithin(root: string, target: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside ${root}: ${target}`);
  }
}

function legacyArtifactHash(artifactPath: string, kind: PlanStorageLegacyArtifact["kind"], lease: PlanStorageLease): string {
  if (kind === "directory") return inventoryPlanStorageDirectory(artifactPath, lease).hash;
  const stat = fs.lstatSync(artifactPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Plan storage legacy artifact is not one plain file: ${artifactPath}`);
  }
  return sha256(fs.readFileSync(artifactPath));
}

function validateLegacyResolutionManifest(
  manifest: StoredPlanStorageLegacyResolution,
  expectedRoleDir?: string
): StoredPlanStorageLegacyResolution {
  const roleDir = path.resolve(manifest.roleDir);
  const planId = canonicalLogicalPlanId(manifest.planId);
  const storageId = canonicalPlanStorageKey(planId);
  if (manifest.schemaVersion !== 1 || manifest.kind !== "plan_storage_legacy_resolution"
    || (manifest.status !== "duplicate_retired" && manifest.status !== "conflict_quarantined")
    || !/^[A-Za-z0-9_-]{1,128}$/.test(manifest.transactionId)
    || manifest.storageId !== storageId || !Array.isArray(manifest.artifacts)
    || (expectedRoleDir && roleDir !== path.resolve(expectedRoleDir))) {
    throw new Error("Plan storage legacy resolution manifest is invalid.");
  }
  return { ...manifest, roleDir, planId, storageId };
}

function copyCanonicalLegacyEvidence(
  lease: PlanStorageLease,
  canonicalDirectory: string,
  canonicalInventoryHash: string,
  evidenceDirectory: string
): void {
  const destination = path.join(evidenceDirectory, "canonical");
  if (fs.existsSync(destination)) {
    const inventory = inventoryPlanStorageDirectory(destination, lease);
    if (inventory.hash !== canonicalInventoryHash) {
      throw new Error(`Plan storage canonical conflict evidence changed: ${destination}`);
    }
    return;
  }
  const sourceInventory = inventoryPlanStorageDirectory(canonicalDirectory, lease);
  if (sourceInventory.hash !== canonicalInventoryHash) {
    throw new Error(`Plan storage canonical source changed before evidence capture: ${canonicalDirectory}`);
  }
  const candidate = path.join(evidenceDirectory, `.canonical.${randomUUID()}.candidate`);
  fs.mkdirSync(candidate, { recursive: true });
  for (const file of sourceInventory.files) {
    assertPlanStorageLeaseOwner(lease);
    const content = fs.readFileSync(path.join(canonicalDirectory, ...file.path.split("/")));
    if (content.byteLength !== file.bytes || sha256(content) !== file.sha256) {
      throw new Error(`Plan storage canonical evidence source changed while copying: ${file.path}`);
    }
    atomicWriteFileSync(path.join(candidate, ...file.path.split("/")), content);
  }
  if (inventoryPlanStorageDirectory(candidate, lease).hash !== canonicalInventoryHash) {
    throw new Error("Plan storage canonical conflict evidence inventory changed while staging.");
  }
  publishPlanStorageDirectoryUnderLease(lease, candidate, destination);
}

function applyStoredLegacyResolutionUnderLease(
  lease: PlanStorageLease,
  manifest: StoredPlanStorageLegacyResolution,
  transactionRoot: string,
  recovered: boolean
): PlanStorageLegacyResolutionResult {
  assertPlanStorageLeaseOwner(lease);
  if (lease.roleDir !== manifest.roleDir || lease.planId !== manifest.planId || lease.storageId !== manifest.storageId) {
    throw new Error(`Plan storage legacy resolution lease identity mismatch: ${manifest.transactionId}`);
  }
  const receiptPath = path.join(transactionRoot, "receipt.json");
  const evidenceDirectory = path.join(transactionRoot, "evidence");
  if (fs.existsSync(receiptPath)) {
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as { status?: unknown; evidenceDirectory?: unknown };
    if (receipt.status !== manifest.status || path.resolve(String(receipt.evidenceDirectory || "")) !== path.resolve(evidenceDirectory)) {
      throw new Error(`Plan storage legacy resolution receipt identity mismatch: ${manifest.transactionId}`);
    }
    return { status: manifest.status, receiptPath, evidenceDirectory, recovered };
  }
  const canonicalDirectory = path.resolve(manifest.canonicalDirectory);
  assertPathWithin(plansRoot(lease.roleDir), canonicalDirectory, "Canonical plan directory");
  if (inventoryPlanStorageDirectory(canonicalDirectory, lease).hash !== manifest.canonicalInventoryHash) {
    throw new Error(`Plan storage canonical target changed during legacy resolution: ${canonicalDirectory}`);
  }
  assertPlanStorageLeaseOwner(lease);
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  if (manifest.status === "conflict_quarantined") {
    copyCanonicalLegacyEvidence(lease, canonicalDirectory, manifest.canonicalInventoryHash, evidenceDirectory);
  }
  const seenEvidencePaths = new Set<string>();
  for (const artifact of manifest.artifacts) {
    const relativeEvidencePath = canonicalRelativePath(artifact.evidenceRelativePath);
    const evidenceKey = windowsPlanStoragePathCollisionKey(relativeEvidencePath);
    if (seenEvidencePaths.has(evidenceKey)) {
      throw new Error(`Plan storage legacy resolution repeats evidence path: ${relativeEvidencePath}`);
    }
    seenEvidencePaths.add(evidenceKey);
    const sourcePath = path.resolve(artifact.sourcePath);
    assertPathWithin(plansRoot(lease.roleDir), sourcePath, "Legacy plan artifact");
    const targetPath = path.join(evidenceDirectory, "legacy", ...relativeEvidencePath.split("/"));
    const sourceExists = fs.existsSync(sourcePath);
    const targetExists = fs.existsSync(targetPath);
    if (sourceExists && targetExists) {
      throw new Error(`Plan storage legacy artifact exists in live and evidence locations: ${relativeEvidencePath}`);
    }
    const currentPath = sourceExists ? sourcePath : targetExists ? targetPath : "";
    if (!currentPath) throw new Error(`Plan storage legacy artifact disappeared: ${relativeEvidencePath}`);
    if (legacyArtifactHash(currentPath, artifact.kind, lease) !== artifact.expectedHash) {
      throw new Error(`Plan storage legacy artifact changed: ${relativeEvidencePath}`);
    }
    if (!sourceExists) continue;
    assertPlanStorageLeaseOwner(lease);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    assertPlanStorageLeaseOwner(lease);
    fs.renameSync(sourcePath, targetPath);
    assertPlanStorageLeaseOwner(lease);
    if (legacyArtifactHash(targetPath, artifact.kind, lease) !== artifact.expectedHash) {
      throw new Error(`Plan storage legacy evidence changed during publication: ${relativeEvidencePath}`);
    }
  }
  const committedAt = new Date().toISOString();
  assertPlanStorageLeaseOwner(lease);
  atomicWriteFileSync(receiptPath, `${JSON.stringify({
    schemaVersion: 1,
    kind: "plan_storage_legacy_resolution_receipt",
    status: manifest.status,
    transactionId: manifest.transactionId,
    planId: manifest.planId,
    storageId: manifest.storageId,
    canonicalInventoryHash: manifest.canonicalInventoryHash,
    legacyInventoryHash: manifest.legacyInventoryHash,
    evidenceDirectory,
    committedAt
  }, null, 2)}\n`);
  return { status: manifest.status, receiptPath, evidenceDirectory, recovered };
}

export function commitPlanStorageLegacyResolutionUnderLease(
  lease: PlanStorageLease,
  input: CommitPlanStorageLegacyResolutionInput
): PlanStorageLegacyResolutionResult {
  assertPlanStorageLeaseOwner(lease);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.transactionId)) {
    throw new Error("Plan storage legacy resolution transactionId is invalid.");
  }
  if (input.status !== "duplicate_retired" && input.status !== "conflict_quarantined") {
    throw new Error("Plan storage legacy resolution status is invalid.");
  }
  if (!/^[a-f0-9]{64}$/.test(input.canonicalInventoryHash)) {
    throw new Error("Plan storage legacy resolution canonical inventory is invalid.");
  }
  if (!/^[a-f0-9]{64}$/.test(input.legacyInventoryHash)) {
    throw new Error("Plan storage legacy resolution projected inventory is invalid.");
  }
  if (!input.artifacts.length) throw new Error("Plan storage legacy resolution has no live artifacts.");
  const transactionRoot = legacyResolutionRoot(lease, input.transactionId);
  const manifestPath = path.join(transactionRoot, "manifest.json");
  let manifest: StoredPlanStorageLegacyResolution;
  if (fs.existsSync(manifestPath)) {
    manifest = validateLegacyResolutionManifest(
      JSON.parse(fs.readFileSync(manifestPath, "utf8")) as StoredPlanStorageLegacyResolution,
      lease.roleDir
    );
    const expected = JSON.stringify({ ...input, canonicalDirectory: path.resolve(input.canonicalDirectory) });
    const actual = JSON.stringify({
      transactionId: manifest.transactionId,
      status: manifest.status,
      canonicalDirectory: manifest.canonicalDirectory,
      canonicalInventoryHash: manifest.canonicalInventoryHash,
      legacyInventoryHash: manifest.legacyInventoryHash,
      artifacts: manifest.artifacts
    });
    if (actual !== expected) throw new Error(`Plan storage legacy resolution transactionId has different content: ${input.transactionId}`);
  } else {
    manifest = {
      ...input,
      canonicalDirectory: path.resolve(input.canonicalDirectory),
      artifacts: input.artifacts.map((artifact) => ({ ...artifact, sourcePath: path.resolve(artifact.sourcePath) })),
      schemaVersion: 1,
      kind: "plan_storage_legacy_resolution",
      roleDir: lease.roleDir,
      planId: lease.planId,
      storageId: lease.storageId,
      preparedAt: new Date().toISOString()
    };
    assertPlanStorageLeaseOwner(lease);
    fs.mkdirSync(transactionRoot, { recursive: true });
    atomicWriteFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return applyStoredLegacyResolutionUnderLease(lease, manifest, transactionRoot, false);
}

export function recoverPlanStorageLegacyResolutions(roleDir: string): PlanStorageLegacyRecoveryResult {
  const resolvedRoleDir = path.resolve(roleDir);
  const root = path.join(plansRoot(resolvedRoleDir), "quarantine", "plan-storage-legacy-resolutions");
  const manifests = fixedDepthTransactionManifests(root, 2);
  const result: PlanStorageLegacyRecoveryResult = { results: [], failures: [] };
  for (const manifestPath of manifests.sort()) {
    try {
      if (fs.existsSync(path.join(path.dirname(manifestPath), "receipt.json"))) continue;
      const manifest = validateLegacyResolutionManifest(
        JSON.parse(fs.readFileSync(manifestPath, "utf8")) as StoredPlanStorageLegacyResolution,
        resolvedRoleDir
      );
      const outcome = withPlanStorageLease(resolvedRoleDir, manifest.planId, (lease) =>
        applyStoredLegacyResolutionUnderLease(lease, manifest, path.dirname(manifestPath), true)
      );
      result.results.push(outcome);
    } catch (error) {
      result.failures.push({
        transactionPath: manifestPath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return result;
}

export function readPlanStoragePackage(
  roleDir: string,
  planId: string,
  bucket: PlanStorageBucket
): ReadPlanStoragePackageResult {
  const location = resolveCanonicalPlanStorageLocation(roleDir, planId);
  if (!location || location.bucket !== bucket) throw new Error(`Canonical ${bucket} plan package does not exist: ${planId}`);
  const physical = physicalPackageInventory(location.directory);
  validatePackageIdentity(location.planId, bucket, physical.files);
  return { ...location, inventoryHash: physical.hash, files: physical.files };
}

export function readCanonicalPlanStoragePackageUnderLease(
  lease: PlanStorageLease
): ReadPlanStoragePackageResult {
  assertPlanStorageLeaseOwner(lease);
  const location = resolveCanonicalPlanStorageLocation(lease.roleDir, lease.planId);
  if (!location) throw new Error(`Canonical plan package does not exist: ${lease.planId}`);
  const physical = physicalPackageInventory(location.directory);
  validatePackageIdentity(location.planId, location.bucket, physical.files);
  assertPlanStorageLeaseOwner(lease);
  return { ...location, inventoryHash: physical.hash, files: physical.files };
}

type StoredPlanStorageLifecycleTransition = {
  schemaVersion: 1;
  kind: "plan_storage_lifecycle_transition";
  status: "prepared";
  transactionKind: PlanStorageLifecycleKind;
  transactionId: string;
  roleDir: string;
  planId: string;
  storageId: string;
  fromBucket: PlanStorageBucket | null;
  toBucket: PlanStorageBucket;
  expectedSourceInventoryHash?: string;
  finalInventoryHash: string;
  specHash: string;
  preparedAt: string;
};

function lifecycleTransactionRoot(lease: PlanStorageLease, transactionId: string): string {
  return path.join(
    plansRoot(lease.roleDir),
    "quarantine",
    "plan-storage-lifecycle-transactions",
    lease.storageId,
    transactionId
  );
}

function lifecycleSpecHash(input: Omit<StoredPlanStorageLifecycleTransition,
  "schemaVersion" | "kind" | "status" | "roleDir" | "storageId" | "specHash" | "preparedAt"
>): string {
  return sha256(JSON.stringify(input));
}

function readLifecycleManifest(
  manifestPath: string,
  expectedRoleDir?: string
): StoredPlanStorageLifecycleTransition {
  const value = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as StoredPlanStorageLifecycleTransition;
  const roleDir = path.resolve(value.roleDir);
  const planId = canonicalLogicalPlanId(value.planId);
  const storageId = canonicalPlanStorageKey(planId);
  if (value.schemaVersion !== 1 || value.kind !== "plan_storage_lifecycle_transition" || value.status !== "prepared"
    || !new Set<PlanStorageLifecycleKind>(["plan-create", "plan-update", "plan-archive"]).has(value.transactionKind)
    || !/^[A-Za-z0-9_-]{1,128}$/.test(value.transactionId) || value.storageId !== storageId
    || (value.fromBucket !== null && value.fromBucket !== "active" && value.fromBucket !== "archive")
    || (value.toBucket !== "active" && value.toBucket !== "archive")
    || (value.expectedSourceInventoryHash !== undefined && !/^[a-f0-9]{64}$/.test(value.expectedSourceInventoryHash))
    || !/^[a-f0-9]{64}$/.test(value.finalInventoryHash) || !/^[a-f0-9]{64}$/.test(value.specHash)
    || (expectedRoleDir && roleDir !== path.resolve(expectedRoleDir))) {
    throw new Error(`Plan storage lifecycle manifest is invalid: ${manifestPath}`);
  }
  return { ...value, roleDir, planId, storageId };
}

function completeLifecycleTransitionUnderLease(
  lease: PlanStorageLease,
  manifest: StoredPlanStorageLifecycleTransition,
  transactionRoot: string
): PlanStorageLifecycleTransitionResult {
  assertPlanStorageLeaseOwner(lease);
  if (lease.roleDir !== manifest.roleDir || lease.planId !== manifest.planId || lease.storageId !== manifest.storageId) {
    throw new Error(`Plan storage lifecycle lease identity mismatch: ${manifest.transactionId}`);
  }
  const receiptPath = path.join(transactionRoot, "receipt.json");
  const payload = path.join(transactionRoot, "payload");
  const previousDirectory = path.join(transactionRoot, "previous");
  const target = canonicalPlanDirectory(lease.roleDir, lease.planId, manifest.toBucket);
  const targetInventory = (): { hash: string; files: PlanStoragePackageFile[] } | null =>
    fs.existsSync(target) ? physicalPackageInventory(target) : null;
  const receiptExists = fs.existsSync(receiptPath);
  const alreadyPublished = targetInventory();
  if (receiptExists) {
    if (!alreadyPublished || alreadyPublished.hash !== manifest.finalInventoryHash) {
      throw new Error(`Plan storage lifecycle receipt target changed: ${manifest.transactionId}`);
    }
    validatePackageIdentity(lease.planId, manifest.toBucket, alreadyPublished.files);
    return {
      status: "already_committed",
      receiptPath,
      ...(fs.existsSync(previousDirectory) ? { previousDirectory } : {}),
      bucket: manifest.toBucket,
      inventoryHash: manifest.finalInventoryHash
    };
  }
  let finalAtTarget = alreadyPublished?.hash === manifest.finalInventoryHash;
  if (alreadyPublished && !finalAtTarget) {
    if (manifest.fromBucket !== manifest.toBucket || fs.existsSync(previousDirectory)) {
      throw new Error(`Plan storage lifecycle target is occupied by different content: ${target}`);
    }
  }
  if (!finalAtTarget && !fs.existsSync(previousDirectory)) {
    if (manifest.fromBucket === null) {
      const existing = resolveCanonicalPlanStorageLocation(lease.roleDir, lease.planId);
      if (existing) throw new Error(`Plan storage create target is already occupied: ${existing.directory}`);
    } else {
      const source = canonicalPlanDirectory(lease.roleDir, lease.planId, manifest.fromBucket);
      if (!fs.existsSync(source)) throw new Error(`Plan storage lifecycle source disappeared: ${source}`);
      const sourceInventory = inventoryPlanStorageDirectory(source, lease);
      if (sourceInventory.hash !== manifest.expectedSourceInventoryHash) {
        throw new Error(`Plan storage lifecycle source changed: ${source}`);
      }
      publishPlanStorageDirectoryUnderLease(lease, source, previousDirectory);
    }
  }
  if (fs.existsSync(previousDirectory) && manifest.expectedSourceInventoryHash
    && inventoryPlanStorageDirectory(previousDirectory, lease).hash !== manifest.expectedSourceInventoryHash) {
    throw new Error(`Plan storage lifecycle rollback inventory changed: ${previousDirectory}`);
  }
  if (!finalAtTarget) {
    if (!fs.existsSync(payload)) throw new Error(`Plan storage lifecycle staged snapshot disappeared: ${payload}`);
    const staged = physicalPackageInventory(payload);
    if (staged.hash !== manifest.finalInventoryHash) {
      throw new Error(`Plan storage lifecycle staged snapshot changed: ${payload}`);
    }
    validatePackageIdentity(lease.planId, manifest.toBucket, staged.files);
    publishPlanStorageDirectoryUnderLease(lease, payload, target);
    finalAtTarget = true;
  }
  const published = targetInventory();
  if (!finalAtTarget || !published || published.hash !== manifest.finalInventoryHash) {
    throw new Error(`Plan storage lifecycle final snapshot was not published: ${target}`);
  }
  validatePackageIdentity(lease.planId, manifest.toBucket, published.files);
  const committedAt = new Date().toISOString();
  assertPlanStorageLeaseOwner(lease);
  atomicWriteFileSync(receiptPath, `${JSON.stringify({
    schemaVersion: 1,
    kind: "plan_storage_lifecycle_transition_receipt",
    status: "committed",
    transactionKind: manifest.transactionKind,
    transactionId: manifest.transactionId,
    planId: manifest.planId,
    storageId: manifest.storageId,
    fromBucket: manifest.fromBucket,
    toBucket: manifest.toBucket,
    expectedSourceInventoryHash: manifest.expectedSourceInventoryHash,
    finalInventoryHash: manifest.finalInventoryHash,
    previousDirectory: fs.existsSync(previousDirectory) ? previousDirectory : undefined,
    committedAt
  }, null, 2)}\n`);
  emitCommit({
    kind: manifest.transactionKind,
    roleDir: manifest.roleDir,
    planId: manifest.planId,
    storageId: manifest.storageId,
    bucket: manifest.toBucket,
    transactionId: manifest.transactionId,
    changedPaths: published.files.map(file => file.path),
    committedAt
  });
  return {
    status: "committed",
    receiptPath,
    ...(fs.existsSync(previousDirectory) ? { previousDirectory } : {}),
    bucket: manifest.toBucket,
    inventoryHash: manifest.finalInventoryHash
  };
}

export function commitPlanLifecycleTransitionUnderLease(
  lease: PlanStorageLease,
  input: CommitPlanLifecycleTransitionInput
): PlanStorageLifecycleTransitionResult {
  assertPlanStorageLeaseOwner(lease);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.transactionId)) {
    throw new Error("Plan storage lifecycle transactionId is invalid.");
  }
  if (!new Set<PlanStorageLifecycleKind>(["plan-create", "plan-update", "plan-archive"]).has(input.kind)) {
    throw new Error("Plan storage lifecycle kind is invalid.");
  }
  if (input.fromBucket !== null && input.fromBucket !== "active" && input.fromBucket !== "archive") {
    throw new Error("Plan storage lifecycle source bucket is invalid.");
  }
  if (input.toBucket !== "active" && input.toBucket !== "archive") {
    throw new Error("Plan storage lifecycle destination bucket is invalid.");
  }
  if ((input.fromBucket === null) !== (input.kind === "plan-create")) {
    throw new Error("Only plan-create may omit its source bucket.");
  }
  if (input.fromBucket !== null && !/^[a-f0-9]{64}$/.test(input.expectedSourceInventoryHash || "")) {
    throw new Error("Plan storage lifecycle expected source inventory is required.");
  }
  const files = canonicalPackageFiles(input.files);
  const finalInventoryHash = packageInventoryHash(files);
  validatePackageIdentity(lease.planId, input.toBucket, files);
  claimPlanStorageIdentity(lease);
  const transactionRoot = lifecycleTransactionRoot(lease, input.transactionId);
  fs.mkdirSync(transactionRoot, { recursive: true });
  ensurePackagePayloadUnderLease(lease, transactionRoot, files, finalInventoryHash);
  const manifestPath = path.join(transactionRoot, "manifest.json");
  const specIdentity = {
    transactionKind: input.kind,
    transactionId: input.transactionId,
    planId: lease.planId,
    fromBucket: input.fromBucket,
    toBucket: input.toBucket,
    expectedSourceInventoryHash: input.expectedSourceInventoryHash,
    finalInventoryHash
  };
  const specHash = lifecycleSpecHash(specIdentity);
  let manifest: StoredPlanStorageLifecycleTransition;
  if (fs.existsSync(manifestPath)) {
    manifest = readLifecycleManifest(manifestPath, lease.roleDir);
    if (manifest.specHash !== specHash) {
      throw new Error(`Plan storage lifecycle transactionId has different content: ${input.transactionId}`);
    }
  } else {
    manifest = {
      schemaVersion: 1,
      kind: "plan_storage_lifecycle_transition",
      status: "prepared",
      ...specIdentity,
      roleDir: lease.roleDir,
      storageId: lease.storageId,
      specHash,
      preparedAt: new Date().toISOString()
    };
    assertPlanStorageLeaseOwner(lease);
    atomicWriteFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return completeLifecycleTransitionUnderLease(lease, manifest, transactionRoot);
}

export function recoverPlanLifecycleTransitions(roleDir: string): PlanStorageLifecycleRecoveryResult {
  const resolvedRoleDir = path.resolve(roleDir);
  const root = path.join(plansRoot(resolvedRoleDir), "quarantine", "plan-storage-lifecycle-transactions");
  const manifests = fixedDepthTransactionManifests(root, 2);
  const result: PlanStorageLifecycleRecoveryResult = { results: [], failures: [] };
  for (const manifestPath of manifests.sort()) {
    try {
      if (fs.existsSync(path.join(path.dirname(manifestPath), "receipt.json"))) continue;
      const manifest = readLifecycleManifest(manifestPath, resolvedRoleDir);
      const outcome = withPlanStorageLease(resolvedRoleDir, manifest.planId, (lease) =>
        completeLifecycleTransitionUnderLease(lease, manifest, path.dirname(manifestPath))
      );
      result.results.push(outcome);
    } catch (error) {
      result.failures.push({
        transactionPath: manifestPath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return result;
}

export function commitPlanStoragePackage(input: CommitPlanStoragePackageInput): PlanStoragePackageCommitResult {
  const roleDir = path.resolve(input.roleDir);
  const planId = canonicalLogicalPlanId(input.planId);
  const storageId = canonicalPlanStorageKey(planId);
  if (input.storageId !== storageId) throw new Error("Plan storage package storageId does not match its logical plan id.");
  if (input.bucket !== "active" && input.bucket !== "archive") throw new Error("Plan storage package bucket is invalid.");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.transactionId)) throw new Error("Plan storage package transactionId is invalid.");
  const normalizedInput = { ...input, roleDir, planId, storageId };
  const files = canonicalPackageFiles(input.files);
  const inventoryHash = packageInventoryHash(files);
  if (inventoryHash !== input.inventoryHash) throw new Error("Plan storage package inventory hash does not match its bytes.");
  validatePackageIdentity(planId, input.bucket, files);
  const specHash = packageSpecHash(normalizedInput, files);
  return withPlanStorageLease(roleDir, planId, (lease) => {
    claimPlanStorageIdentity(lease);
    const receiptPath = packageReceiptPath(normalizedInput);
    const receipt = readPackageReceipt(receiptPath);
    if (receipt) {
      if (receipt.specHash !== specHash) throw new Error(`Plan storage package transactionId has different content: ${input.transactionId}`);
      if (receipt.status !== "applied") {
        return {
          status: "conflict",
          reason: receipt.reason,
          currentInventoryHash: receipt.currentInventoryHash,
          quarantinePath: receipt.quarantinePath,
          receiptPath
        };
      }
      try {
        const current = resolveCanonicalPlanStorageLocation(roleDir, planId);
        if (current?.bucket === input.bucket && physicalPackageInventory(current.directory).hash === inventoryHash) {
          return {
            status: "unchanged",
            currentInventoryHash: inventoryHash,
            receiptPath
          };
        }
      } catch {
        // A completed receipt is historical evidence, not current storage.
        // Continue through normal validation so missing payloads are restored
        // and divergent or invalid storage still fails closed.
      }
    }
    const transactionRoot = packageTransactionRoot(normalizedInput);
    const manifestPath = path.join(transactionRoot, "manifest.json");
    fs.mkdirSync(transactionRoot, { recursive: true });
    const payload = ensurePackagePayloadUnderLease(lease, transactionRoot, files, inventoryHash);
    if (fs.existsSync(manifestPath)) {
      const existing = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { specHash?: unknown };
      if (existing.specHash !== specHash) throw new Error(`Plan storage package transactionId has different prepared content: ${input.transactionId}`);
    } else {
      assertPlanStorageLeaseOwner(lease);
      atomicWriteFileSync(manifestPath, `${JSON.stringify({
        schemaVersion: 1,
        kind: "plan_storage_package_transaction",
        status: "prepared",
        transactionId: input.transactionId,
        planId,
        storageId,
        bucket: input.bucket,
        inventoryHash,
        specHash,
        preparedAt: new Date().toISOString()
      }, null, 2)}\n`);
    }
    const staged = physicalPackageInventory(payload);
    if (staged.hash !== inventoryHash) throw new Error("Plan storage package staging inventory changed.");
    validatePackageIdentity(planId, input.bucket, staged.files);
    let existingLocation: CanonicalPlanStorageLocation | null = null;
    let invalidExistingStorage: string | undefined;
    try {
      existingLocation = resolveCanonicalPlanStorageLocation(roleDir, planId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/identity collision/i.test(message)) throw error;
      invalidExistingStorage = message;
    }
    const target = canonicalPlanDirectory(roleDir, planId, input.bucket);
    let result: PlanStoragePackageCommitResult;
    let storedReceipt: PackageTransactionReceipt;
    if (invalidExistingStorage) {
      const quarantinePath = path.join(
        plansRoot(roleDir),
        "quarantine",
        "plan-storage-package-conflicts",
        storageId,
        `${input.transactionId}-${inventoryHash.slice(0, 12)}`
      );
      publishPlanStorageDirectoryUnderLease(lease, payload, quarantinePath);
      result = {
        status: "conflict",
        reason: `canonical_storage_is_invalid:${invalidExistingStorage}`,
        quarantinePath,
        receiptPath
      };
      storedReceipt = {
        schemaVersion: 1,
        kind: "plan_storage_package_commit",
        status: "conflict",
        transactionId: input.transactionId,
        planId,
        storageId,
        bucket: input.bucket,
        inventoryHash,
        specHash,
        reason: result.reason,
        quarantinePath,
        committedAt: new Date().toISOString()
      };
    } else if (existingLocation) {
      const current = physicalPackageInventory(existingLocation.directory);
      if (existingLocation.bucket === input.bucket && current.hash === inventoryHash) {
        result = { status: "unchanged", currentInventoryHash: current.hash, receiptPath };
        storedReceipt = {
          schemaVersion: 1,
          kind: "plan_storage_package_commit",
          status: "applied",
          transactionId: input.transactionId,
          planId,
          storageId,
          bucket: input.bucket,
          inventoryHash,
          specHash,
          currentInventoryHash: current.hash,
          committedAt: new Date().toISOString()
        };
      } else if (input.bucket === "archive" && existingLocation.bucket === "active"
        && input.archiveDominatesActive?.(existingLocation.directory, payload, planId)) {
        const quarantinePath = path.join(
          plansRoot(roleDir),
          "quarantine",
          "plan-storage-package-superseded",
          storageId,
          `${input.transactionId}-${current.hash.slice(0, 12)}`
        );
        publishPlanStorageDirectoryUnderLease(lease, existingLocation.directory, quarantinePath);
        publishPlanStorageDirectoryUnderLease(lease, payload, target);
        const published = physicalPackageInventory(target);
        if (published.hash !== inventoryHash) throw new Error("Plan storage archive package changed during atomic publication.");
        result = { status: "applied", currentInventoryHash: published.hash, quarantinePath, receiptPath };
        storedReceipt = {
          schemaVersion: 1,
          kind: "plan_storage_package_commit",
          status: "applied",
          transactionId: input.transactionId,
          planId,
          storageId,
          bucket: input.bucket,
          inventoryHash,
          specHash,
          currentInventoryHash: published.hash,
          quarantinePath,
          committedAt: new Date().toISOString()
        };
      } else {
        const reason = existingLocation.bucket === "archive" && input.bucket === "active"
          ? "canonical_archive_is_terminal"
          : existingLocation.bucket === "active" && input.bucket === "archive"
            ? "incoming_archive_does_not_prove_dominance"
            : `canonical_${input.bucket}_inventory_diverged`;
        const quarantinePath = path.join(
          plansRoot(roleDir),
          "quarantine",
          "plan-storage-package-conflicts",
          storageId,
          `${input.transactionId}-${inventoryHash.slice(0, 12)}`
        );
        publishPlanStorageDirectoryUnderLease(lease, payload, quarantinePath);
        result = { status: "conflict", reason, currentInventoryHash: current.hash, quarantinePath, receiptPath };
        storedReceipt = {
          schemaVersion: 1,
          kind: "plan_storage_package_commit",
          status: "conflict",
          transactionId: input.transactionId,
          planId,
          storageId,
          bucket: input.bucket,
          inventoryHash,
          specHash,
          reason,
          currentInventoryHash: current.hash,
          quarantinePath,
          committedAt: new Date().toISOString()
        };
      }
    } else {
      publishPlanStorageDirectoryUnderLease(lease, payload, target);
      const published = physicalPackageInventory(target);
      if (published.hash !== inventoryHash) throw new Error("Plan storage package changed during atomic publication.");
      result = { status: "applied", currentInventoryHash: published.hash, receiptPath };
      storedReceipt = {
        schemaVersion: 1,
        kind: "plan_storage_package_commit",
        status: "applied",
        transactionId: input.transactionId,
        planId,
        storageId,
        bucket: input.bucket,
        inventoryHash,
        specHash,
        currentInventoryHash: published.hash,
        committedAt: new Date().toISOString()
      };
    }
    atomicWriteFileSync(receiptPath, `${JSON.stringify(storedReceipt, null, 2)}\n`);
    if (result.status === "applied") {
      emitCommit({
        kind: "package",
        roleDir,
        planId,
        storageId,
        bucket: input.bucket,
        transactionId: input.transactionId,
        changedPaths: files.map((file) => file.path),
        committedAt: storedReceipt.committedAt
      });
    }
    return result;
  });
}

export function recoverPlanStoragePackageTransactions(
  roleDir: string,
  options: { archiveDominatesActive?: CommitPlanStoragePackageInput["archiveDominatesActive"] } = {}
): PlanStoragePackageRecoveryResult {
  const resolvedRoleDir = path.resolve(roleDir);
  const root = path.join(plansRoot(resolvedRoleDir), "quarantine", "plan-storage-package-transactions");
  const manifests = fixedDepthTransactionManifests(root, 2);
  const result: PlanStoragePackageRecoveryResult = { results: [], failures: [] };
  for (const manifestPath of manifests.sort()) {
    try {
      const value = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        schemaVersion?: unknown;
        kind?: unknown;
        status?: unknown;
        transactionId?: unknown;
        planId?: unknown;
        storageId?: unknown;
        bucket?: unknown;
        inventoryHash?: unknown;
      };
      if (value.schemaVersion !== 1 || value.kind !== "plan_storage_package_transaction" || value.status !== "prepared") {
        throw new Error("Plan storage package transaction manifest is invalid.");
      }
      const planId = canonicalLogicalPlanId(value.planId);
      const storageId = canonicalPlanStorageKey(planId);
      const bucket = value.bucket === "active" || value.bucket === "archive" ? value.bucket : null;
      const transactionId = String(value.transactionId || "");
      const inventoryHash = String(value.inventoryHash || "").toLocaleLowerCase("en-US");
      if (!bucket || value.storageId !== storageId || !/^[A-Za-z0-9_-]{1,128}$/.test(transactionId)
        || !/^[a-f0-9]{64}$/.test(inventoryHash)) {
        throw new Error("Plan storage package transaction identity is invalid.");
      }
      const transactionRoot = path.dirname(manifestPath);
      const payload = path.join(transactionRoot, "payload");
      const target = canonicalPlanDirectory(resolvedRoleDir, planId, bucket);
      const staged = fs.existsSync(payload)
        ? physicalPackageInventory(payload)
        : physicalPackageInventory(target);
      if (staged.hash !== inventoryHash) throw new Error("Plan storage package transaction payload is incomplete or changed.");
      validatePackageIdentity(planId, bucket, staged.files);
      const committed = commitPlanStoragePackage({
        roleDir: resolvedRoleDir,
        planId,
        storageId,
        bucket,
        inventoryHash,
        files: staged.files,
        transactionId,
        archiveDominatesActive: bucket === "archive" ? options.archiveDominatesActive : undefined
      });
      result.results.push({ ...committed, planId, storageId, bucket, inventoryHash });
    } catch (error) {
      result.failures.push({
        transactionPath: manifestPath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return result;
}

function storedTransactionOperations(spec: PlanStorageTransactionSpec): StoredTransactionOperation[] {
  if (!Array.isArray(spec.operations) || spec.operations.length === 0) {
    throw new Error("Plan storage transaction requires at least one operation.");
  }
  const targetKeys = new Set<string>();
  return spec.operations.map((operation) => {
    const relativePath = canonicalRelativePath(operation.relativePath);
    const targetKey = windowsPlanStoragePathCollisionKey(relativePath);
    if (targetKeys.has(targetKey)) throw new Error(`Plan storage transaction repeats a target: ${relativePath}`);
    targetKeys.add(targetKey);
    if (operation.type === "replace-file") {
      const content = Buffer.from(operation.content);
      return { type: operation.type, relativePath, size: content.byteLength, sha256: sha256(content) };
    }
    if (operation.type !== "publish-directory" || !operation.files.length) {
      throw new Error(`Plan storage transaction has an invalid operation: ${relativePath}`);
    }
    const fileKeys = new Set<string>();
    const files = operation.files.map((file) => {
      const filePath = canonicalRelativePath(file.relativePath);
      const key = windowsPlanStoragePathCollisionKey(filePath);
      if (fileKeys.has(key)) throw new Error(`Plan storage transaction repeats a directory file: ${filePath}`);
      fileKeys.add(key);
      const content = Buffer.from(file.content);
      return { relativePath: filePath, size: content.byteLength, sha256: sha256(content) };
    }).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return { type: operation.type, relativePath, files };
  });
}

function transactionSpecHash(kind: string, operations: StoredTransactionOperation[]): string {
  return sha256(JSON.stringify({ kind, operations }));
}

function repositoryTransactionRoot(roleDir: string, storageId: string, kind: string, transactionId: string): string {
  return path.join(plansRoot(roleDir), "quarantine", "plan-storage-transactions", storageId, kind, transactionId);
}

function stageTransactionPayload(
  root: string,
  spec: PlanStorageTransactionSpec,
  operations: StoredTransactionOperation[],
  hooks?: PlanStorageTransactionHooks
): void {
  const payload = path.join(root, "payload");
  fs.mkdirSync(payload, { recursive: true });
  spec.operations.forEach((operation, index) => {
    const metadata = operations[index]!;
    if (operation.type === "replace-file" && metadata.type === "replace-file") {
      atomicWriteFileSync(path.join(payload, `${index}.file`), Buffer.from(operation.content));
      hooks?.afterPayloadWrite?.(index, operation.relativePath);
      return;
    }
    if (operation.type === "publish-directory" && metadata.type === "publish-directory") {
      for (const file of operation.files) {
        atomicWriteFileSync(path.join(payload, `${index}.directory`, ...canonicalRelativePath(file.relativePath).split("/")), Buffer.from(file.content));
        hooks?.afterPayloadWrite?.(index, `${operation.relativePath}/${file.relativePath}`);
      }
      return;
    }
    throw new Error("Plan storage transaction operation metadata changed while staging.");
  });
}

function verifyStagedTransactionPayload(
  root: string,
  planDirectory: string,
  operations: StoredTransactionOperation[]
): void {
  const payload = path.join(root, "payload");
  operations.forEach((operation, index) => {
    const target = path.join(planDirectory, ...operation.relativePath.split("/"));
    if (operation.type === "replace-file") {
      const staged = path.join(payload, `${index}.file`);
      if (!fs.existsSync(staged)) {
        const current = fs.existsSync(target) ? fs.readFileSync(target) : null;
        if (current && current.byteLength === operation.size && sha256(current) === operation.sha256) return;
        throw new Error(`Plan storage transaction staged file is missing: ${operation.relativePath}`);
      }
      const content = fs.readFileSync(staged);
      if (content.byteLength !== operation.size || sha256(content) !== operation.sha256) {
        throw new Error(`Plan storage transaction staged file changed: ${operation.relativePath}`);
      }
      return;
    }
    const directory = path.join(payload, `${index}.directory`);
    const expectedHash = sha256(JSON.stringify(operation.files.map((file) => [file.relativePath, file.size, file.sha256])));
    if (!fs.existsSync(directory)) {
      if (fs.existsSync(target)) {
        const current = inventoryPlanStorageDirectory(target);
        const currentHash = sha256(JSON.stringify(current.files.map((file) => [file.path, file.bytes, file.sha256])));
        if (currentHash === expectedHash) return;
      }
      throw new Error(`Plan storage transaction staged directory is missing: ${operation.relativePath}`);
    }
    const inventory = inventoryPlanStorageDirectory(directory);
    const actualHash = sha256(JSON.stringify(inventory.files.map((file) => [file.path, file.bytes, file.sha256])));
    if (expectedHash !== actualHash) throw new Error(`Plan storage transaction staged directory changed: ${operation.relativePath}`);
  });
}

function readStoredTransaction(
  manifestPath: string,
  expectedRoleDir?: string
): StoredPlanStorageTransaction {
  const value = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as StoredPlanStorageTransaction;
  if (value?.schemaVersion !== 1 || value.kind !== "plan_storage_repository_transaction" || value.status !== "prepared"
    || (value.transactionKind !== "plan-feedback" && value.transactionKind !== "plan-feedback-revision")
    || !/^[A-Za-z0-9_-]{1,128}$/.test(value.transactionId || "") || !Array.isArray(value.operations)) {
    throw new Error(`Plan storage transaction manifest is invalid: ${manifestPath}`);
  }
  const roleDir = path.resolve(value.roleDir);
  if (expectedRoleDir && roleDir !== path.resolve(expectedRoleDir)) {
    throw new Error(`Plan storage transaction role identity mismatch: ${manifestPath}`);
  }
  const planId = canonicalLogicalPlanId(value.planId);
  const storageId = canonicalPlanStorageKey(planId);
  if (storageId !== value.storageId) throw new Error(`Plan storage transaction identity mismatch: ${manifestPath}`);
  return { ...value, roleDir, planId, storageId };
}

function applyStoredTransactionUnderLease(
  lease: PlanStorageLease,
  manifest: StoredPlanStorageTransaction,
  transactionRoot: string,
  hooks?: PlanStorageTransactionHooks
): PlanStorageTransactionCommitResult {
  assertPlanStorageLeaseOwner(lease);
  if (lease.roleDir !== manifest.roleDir || lease.planId !== manifest.planId || lease.storageId !== manifest.storageId) {
    throw new Error(`Plan storage transaction lease identity mismatch: ${manifest.transactionId}`);
  }
  const receiptPath = path.join(transactionRoot, "receipt.json");
  if (fs.existsSync(receiptPath)) {
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as { specHash?: unknown };
    if (receipt.specHash !== manifest.specHash) throw new Error(`Plan storage transaction receipt identity mismatch: ${manifest.transactionId}`);
    return { status: "already_committed", receiptPath };
  }
  const location = resolveCanonicalPlanStorageLocation(manifest.roleDir, manifest.planId);
  if (!location) throw new Error(`Plan storage transaction canonical plan location disappeared: ${manifest.planId}`);
  verifyStagedTransactionPayload(transactionRoot, location.directory, manifest.operations);
  const payload = path.join(transactionRoot, "payload");
  const changedPaths: string[] = [];
  manifest.operations.forEach((operation, index) => {
    assertPlanStorageLeaseOwner(lease);
    const target = path.join(location.directory, ...operation.relativePath.split("/"));
    assertPlainAncestors(location.directory, target);
    if (operation.type === "replace-file") {
      const stagedFile = path.join(payload, `${index}.file`);
      const content = fs.readFileSync(stagedFile);
      if (fs.existsSync(target)) {
        const current = fs.readFileSync(target);
        if (sha256(current) === operation.sha256 && current.byteLength === operation.size) return;
      }
      notifyBeforePlanStorageMutation(lease);
      atomicWriteFileSync(target, content);
      changedPaths.push(operation.relativePath);
      hooks?.afterOperation?.(index, operation.type);
      return;
    }
    const stagedDirectory = path.join(payload, `${index}.directory`);
    if (fs.existsSync(target)) {
      const current = inventoryPlanStorageDirectory(target, lease);
      const expectedHash = sha256(JSON.stringify(operation.files.map((file) => [file.relativePath, file.size, file.sha256])));
      const actualHash = sha256(JSON.stringify(current.files.map((file) => [file.path, file.bytes, file.sha256])));
      if (actualHash !== expectedHash) throw new Error(`Plan storage transaction directory target contains different content: ${operation.relativePath}`);
      return;
    }
    publishPlanStorageDirectoryUnderLease(lease, stagedDirectory, target);
    changedPaths.push(operation.relativePath);
    hooks?.afterOperation?.(index, operation.type);
  });
  const committedAt = new Date().toISOString();
  atomicWriteFileSync(receiptPath, `${JSON.stringify({
    schemaVersion: 1,
    kind: "plan_storage_repository_transaction_receipt",
    status: "committed",
    transactionKind: manifest.transactionKind,
    transactionId: manifest.transactionId,
    planId: manifest.planId,
    storageId: manifest.storageId,
    bucket: location.bucket,
    specHash: manifest.specHash,
    committedAt
  }, null, 2)}\n`);
  emitCommit({
    kind: manifest.transactionKind,
    roleDir: manifest.roleDir,
    planId: manifest.planId,
    storageId: manifest.storageId,
    bucket: location.bucket,
    transactionId: manifest.transactionId,
    changedPaths,
    committedAt
  });
  return { status: "committed", receiptPath };
}

export function commitPlanStorageTransactionUnderLease(
  lease: PlanStorageLease,
  spec: PlanStorageTransactionSpec
): PlanStorageTransactionCommitResult {
  assertPlanStorageLeaseOwner(lease);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(spec.transactionId || "")) {
    throw new Error("Plan storage transactionId is invalid.");
  }
  if (spec.kind !== "plan-feedback" && spec.kind !== "plan-feedback-revision") {
    throw new Error("Plan storage transaction kind is invalid.");
  }
  const location = resolveCanonicalPlanStorageLocation(lease.roleDir, lease.planId);
  if (!location) throw new Error(`Plan storage transaction requires a canonical plan: ${lease.planId}`);
  const operations = storedTransactionOperations(spec);
  const specHash = transactionSpecHash(spec.kind, operations);
  const semanticHash = String(spec.semanticHash || specHash).toLocaleLowerCase("en-US");
  if (!/^[a-f0-9]{64}$/.test(semanticHash)) throw new Error("Plan storage transaction semanticHash is invalid.");
  const transactionRoot = repositoryTransactionRoot(lease.roleDir, lease.storageId, spec.kind, spec.transactionId);
  const manifestPath = path.join(transactionRoot, "manifest.json");
  let manifest: StoredPlanStorageTransaction;
  if (fs.existsSync(manifestPath)) {
    manifest = readStoredTransaction(manifestPath, lease.roleDir);
    if ((manifest.semanticHash || manifest.specHash) !== semanticHash) {
      throw new Error(`Plan storage transactionId has different semantic content: ${spec.transactionId}`);
    }
  } else {
    manifest = {
      schemaVersion: 1,
      kind: "plan_storage_repository_transaction",
      status: "prepared",
      transactionKind: spec.kind,
      transactionId: spec.transactionId,
      roleDir: lease.roleDir,
      planId: lease.planId,
      storageId: lease.storageId,
      bucket: location.bucket,
      specHash,
      semanticHash,
      operations,
      preparedAt: new Date().toISOString()
    };
    fs.mkdirSync(transactionRoot, { recursive: true });
    stageTransactionPayload(transactionRoot, spec, operations, spec.hooks);
    verifyStagedTransactionPayload(transactionRoot, location.directory, operations);
    atomicWriteFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return applyStoredTransactionUnderLease(lease, manifest, transactionRoot, spec.hooks);
}

export function recoverPlanStorageTransactions(
  roleDir: string,
  options: { kind?: "plan-feedback" | "plan-feedback-revision" } = {}
): PlanStorageTransactionRecoveryResult {
  const root = path.join(plansRoot(roleDir), "quarantine", "plan-storage-transactions");
  const result: PlanStorageTransactionRecoveryResult = { committed: 0, alreadyCommitted: 0, failures: [] };
  const manifests = fixedDepthTransactionManifests(root, 3);
  for (const manifestPath of manifests.sort()) {
    try {
      const manifest = readStoredTransaction(manifestPath, roleDir);
      if (options.kind && manifest.transactionKind !== options.kind) continue;
      const transactionRoot = path.dirname(manifestPath);
      const outcome = withPlanStorageLease(manifest.roleDir, manifest.planId, (lease) =>
        applyStoredTransactionUnderLease(lease, manifest, transactionRoot)
      );
      if (outcome.status === "committed") result.committed += 1;
      else result.alreadyCommitted += 1;
    } catch (error) {
      result.failures.push({ transactionPath: manifestPath, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
