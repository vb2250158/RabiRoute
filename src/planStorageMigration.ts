import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "./shared/filePersistence.js";
import {
  legacyPlanAttachmentDirectory,
  legacyPlanFeedbackAttachmentDirectory,
  legacyPlanFeedbackFile,
  legacyPlanHistoryFile
} from "./planStorageLegacyLayout.js";
import {
  planAttachmentDirectory,
  planBucketForStatus,
  planDirectory,
  planFeedbackAttachmentDirectory
} from "./planStorageLayout.js";
import { windowsPlanStoragePathCollisionKey } from "./planStorageIdentity.js";
import {
  canonicalizeRolePlanStorageDirectories,
  reconcileRolePlanStorageConflicts
} from "./planStorageReconciliation.js";
import {
  commitPlanLifecycleTransitionUnderLease,
  commitPlanStorageLegacyResolutionUnderLease,
  inventoryPlanStorageDirectory,
  recoverPlanStorageLegacyResolutions,
  resolveCanonicalPlanStorageLocation,
  withPlanStorageLease,
  type PlanStorageLegacyArtifact,
  type PlanStoragePackageFile
} from "./planStorageRepository.js";

export type PlanLayoutMigrationResult = {
  migrated: number;
  skipped: number;
  reconciled: number;
  alreadyReconciled: number;
  receipts: string[];
  failures: Array<{ planId: string; error: string }>;
};

export type PlanStorageMigrationDependencies = {
  normalizePlan: (raw: Record<string, unknown>, fallbackId: string) => { id: string; status: unknown } | null;
  onChanged?: () => void;
};

function jsonFiles(directory: string): string[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.toLocaleLowerCase("en-US").endsWith(".json"))
      .map(entry => path.join(directory, entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function remapManagedPath(filePath: string, mappings: Array<{ from: string; to: string }>): string {
  const candidate = path.resolve(filePath);
  for (const mapping of mappings) {
    const relative = path.relative(path.resolve(mapping.from), candidate);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) return path.join(mapping.to, relative);
  }
  return filePath;
}

function rewriteStoragePaths(value: unknown, mappings: Array<{ from: string; to: string }>): unknown {
  if (Array.isArray(value)) return value.map(item => rewriteStoragePaths(item, mappings));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    key === "path" && typeof item === "string"
      ? remapManagedPath(item, mappings)
      : rewriteStoragePaths(item, mappings)
  ]));
}

type LegacyProjectedFile = { path: string; content: Buffer };

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function rewrittenJsonlContent(filePath: string, mappings: Array<{ from: string; to: string }>): Buffer {
  const rewritten = fs.readFileSync(filePath, "utf8").split(/\r?\n/).map(line => {
    if (!line) return line;
    try {
      return JSON.stringify(rewriteStoragePaths(JSON.parse(line), mappings));
    } catch {
      return line;
    }
  });
  return Buffer.from(rewritten.join("\n"), "utf8");
}

function directoryFiles(directory: string, prefix: string): LegacyProjectedFile[] {
  if (!fs.existsSync(directory)) return [];
  const root = path.resolve(directory);
  const files: LegacyProjectedFile[] = [];
  const visit = (current: string, relative = ""): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(current, entry.name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) throw new Error(`Legacy plan storage contains a symbolic link or junction: ${target}`);
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory() && stat.isDirectory()) {
        visit(target, child);
      } else if (entry.isFile() && stat.isFile()) {
        files.push({ path: `${prefix}/${child}`, content: fs.readFileSync(target) });
      } else {
        throw new Error(`Legacy plan storage contains an unsupported entry: ${target}`);
      }
    }
  };
  visit(root);
  return files;
}

function projectedInventoryHash(files: LegacyProjectedFile[]): string {
  const entries = files
    .map(file => [file.path, file.content.byteLength, sha256(file.content)] as const)
    .sort((left, right) => left[0].localeCompare(right[0]));
  const keys = new Set<string>();
  for (const [filePath] of entries) {
    const key = windowsPlanStoragePathCollisionKey(filePath);
    if (keys.has(key)) throw new Error(`Legacy plan storage projects a duplicate canonical path: ${filePath}`);
    keys.add(key);
  }
  return sha256(JSON.stringify(entries));
}

function lifecyclePackageFiles(files: LegacyProjectedFile[]): PlanStoragePackageFile[] {
  return files.map(file => ({
    path: file.path,
    size: file.content.byteLength,
    sha256: sha256(file.content),
    content: Buffer.from(file.content)
  }));
}

function legacyArtifact(
  sourcePath: string,
  evidenceRelativePath: string,
  kind: PlanStorageLegacyArtifact["kind"]
): PlanStorageLegacyArtifact | null {
  if (!fs.existsSync(sourcePath)) return null;
  const expectedHash = kind === "directory"
    ? inventoryPlanStorageDirectory(sourcePath).hash
    : sha256(fs.readFileSync(sourcePath));
  return { sourcePath, evidenceRelativePath, kind, expectedHash };
}

function migrationRecordedAt(plan: Record<string, unknown>): string {
  for (const key of ["updatedAt", "archivedAt", "completedAt", "createdAt"]) {
    const value = typeof plan[key] === "string" ? plan[key].trim() : "";
    if (value) return value;
  }
  return new Date(0).toISOString();
}

function backfillCanonicalPlanHistories(
  roleDir: string,
  dependencies: PlanStorageMigrationDependencies,
  failures: PlanLayoutMigrationResult["failures"]
): number {
  let migrated = 0;
  for (const bucket of ["active", "archive"] as const) {
    const bucketDirectory = path.join(roleDir, "plans", bucket);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(bucketDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const directory = path.join(bucketDirectory, entry.name);
      const planPath = path.join(directory, "plan.json");
      const historyPath = path.join(directory, "history.jsonl");
      if (!fs.existsSync(planPath) || fs.existsSync(historyPath)) continue;
      const raw = readJson(planPath);
      const plan = raw ? dependencies.normalizePlan(raw, entry.name) : null;
      const planId = plan?.id || entry.name;
      if (!raw || !plan) {
        failures.push({ planId, error: `Cannot backfill canonical plan history: ${planPath}` });
        continue;
      }
      try {
        withPlanStorageLease(roleDir, plan.id, () => {
          if (fs.existsSync(historyPath)) return;
          const expectedDirectory = planDirectory(roleDir, plan.id, bucket);
          if (path.resolve(expectedDirectory) !== path.resolve(directory)) {
            throw new Error(`Canonical plan history target does not match plan identity: ${directory}`);
          }
          if (planBucketForStatus(plan.status) !== bucket) {
            throw new Error(`Canonical plan history target does not match plan status: ${plan.id}`);
          }
          const recordedAt = migrationRecordedAt(raw);
          const record = {
            id: `legacy-history-${sha256(JSON.stringify({ planId: plan.id, bucket, recordedAt, after: raw })).slice(0, 48)}`,
            planId: plan.id,
            kind: bucket === "archive" ? "archived" : "created",
            recordedAt,
            after: raw
          };
          atomicWriteFileSync(historyPath, `${JSON.stringify(record)}\n`);
          migrated += 1;
        });
      } catch (error) {
        failures.push({ planId: plan.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return migrated;
}

/**
 * Startup-only migration from the retired file layout into canonical plan
 * directories. READY/runtime code must never call this service.
 */
export function migrateRolePlanLayout(
  roleDir: string,
  dependencies: PlanStorageMigrationDependencies
): PlanLayoutMigrationResult {
  const result: PlanLayoutMigrationResult = {
    migrated: 0,
    skipped: 0,
    reconciled: 0,
    alreadyReconciled: 0,
    receipts: [],
    failures: []
  };
  const legacyRecovery = recoverPlanStorageLegacyResolutions(roleDir);
  const recoveredLegacyCount = legacyRecovery.results.length;
  result.migrated += legacyRecovery.results.length;
  result.receipts.push(...legacyRecovery.results.map(item => item.receiptPath));
  result.failures.push(...legacyRecovery.failures.map(item => ({
    planId: "*:legacy-resolution",
    error: `${item.transactionPath}: ${item.error}`
  })));
  const canonicalization = canonicalizeRolePlanStorageDirectories(roleDir);
  result.migrated += canonicalization.migrated + canonicalization.recovered;
  result.receipts.push(...canonicalization.receipts);
  result.failures.push(...canonicalization.failures);
  const failuresBeforeLegacyFiles = result.failures.length;

  const plansRoot = path.join(roleDir, "plans");
  const legacyFiles = [
    ...jsonFiles(path.join(plansRoot, "items", "active")),
    ...jsonFiles(path.join(plansRoot, "archive"))
  ];
  for (const sourcePlanFile of legacyFiles) {
    const fallbackId = path.basename(sourcePlanFile, ".json");
    const raw = readJson(sourcePlanFile);
    const plan = raw ? dependencies.normalizePlan(raw, fallbackId) : null;
    if (!plan) {
      result.failures.push({ planId: fallbackId, error: `Cannot read legacy plan JSON: ${sourcePlanFile}` });
      continue;
    }
    const bucket = planBucketForStatus(plan.status);
    const destinationDirectory = planDirectory(roleDir, plan.id, bucket);
    const legacyHistory = legacyPlanHistoryFile(roleDir, plan.id);
    const legacyFeedback = legacyPlanFeedbackFile(roleDir, plan.id);
    const legacyAttachments = legacyPlanAttachmentDirectory(roleDir, plan.id);
    const destinationAttachments = planAttachmentDirectory(roleDir, plan.id, bucket);
    const feedbackIds = fs.existsSync(legacyFeedback)
      ? fs.readFileSync(legacyFeedback, "utf8").split(/\r?\n/).flatMap(line => {
        try {
          const id = String((JSON.parse(line) as { id?: unknown }).id || "").trim();
          return id ? [id] : [];
        } catch {
          return [];
        }
      })
      : [];
    const feedbackMoves = [...new Set(feedbackIds)].map(feedbackId => ({
      source: legacyPlanFeedbackAttachmentDirectory(roleDir, feedbackId),
      destination: planFeedbackAttachmentDirectory(roleDir, plan.id, feedbackId, bucket)
    }));

    try {
      withPlanStorageLease(roleDir, plan.id, (lease) => {
        const mappings = [
          { from: legacyAttachments, to: destinationAttachments },
          ...feedbackMoves.map(item => ({ from: item.source, to: item.destination }))
        ];
        const projectedFiles: LegacyProjectedFile[] = [{
          path: "plan.json",
          content: Buffer.from(`${JSON.stringify(rewriteStoragePaths(raw, mappings), null, 2)}\n`, "utf8")
        }];
        if (fs.existsSync(legacyHistory)) {
          projectedFiles.push({ path: "history.jsonl", content: rewrittenJsonlContent(legacyHistory, mappings) });
        }
        if (fs.existsSync(legacyFeedback)) {
          projectedFiles.push({ path: "feedback.jsonl", content: rewrittenJsonlContent(legacyFeedback, mappings) });
        }
        projectedFiles.push(...directoryFiles(legacyAttachments, "attachments"));
        for (const item of feedbackMoves) {
          projectedFiles.push(...directoryFiles(item.source, `feedback-attachments/${path.basename(item.destination)}`));
        }
        const legacyInventoryHash = projectedInventoryHash(projectedFiles);
        const artifacts = [
          legacyArtifact(sourcePlanFile, "plan.json", "file"),
          legacyArtifact(legacyHistory, "history.jsonl", "file"),
          legacyArtifact(legacyFeedback, "feedback.jsonl", "file"),
          legacyArtifact(legacyAttachments, "attachments", "directory"),
          ...feedbackMoves.map(item => legacyArtifact(
            item.source,
            `feedback-attachments/${path.basename(item.destination)}`,
            "directory"
          ))
        ].filter((item): item is PlanStorageLegacyArtifact => Boolean(item));
        if (fs.existsSync(destinationDirectory)) {
          const location = resolveCanonicalPlanStorageLocation(roleDir, plan.id);
          if (!location || path.resolve(location.directory) !== path.resolve(destinationDirectory) || location.bucket !== bucket) {
            throw new Error(`Migration target identity is not the canonical ${bucket} plan: ${destinationDirectory}`);
          }
          const canonicalInventoryHash = inventoryPlanStorageDirectory(destinationDirectory).hash;
          const status = legacyInventoryHash === canonicalInventoryHash
            ? "duplicate_retired" as const
            : "conflict_quarantined" as const;
          const transactionId = `legacy_${sha256(JSON.stringify({
            planId: plan.id,
            bucket,
            legacyInventoryHash,
            canonicalInventoryHash
          }))}`;
          const resolution = commitPlanStorageLegacyResolutionUnderLease(lease, {
            transactionId,
            status,
            canonicalDirectory: destinationDirectory,
            canonicalInventoryHash,
            legacyInventoryHash,
            artifacts
          });
          result.receipts.push(resolution.receiptPath);
          return;
        }
        const lifecycleTransactionId = `legacy_create_${sha256(JSON.stringify({
          planId: plan.id,
          bucket,
          legacyInventoryHash
        }))}`;
        const lifecycle = commitPlanLifecycleTransitionUnderLease(lease, {
          transactionId: lifecycleTransactionId,
          kind: "plan-create",
          fromBucket: null,
          toBucket: bucket,
          files: lifecyclePackageFiles(projectedFiles)
        });
        result.receipts.push(lifecycle.receiptPath);
        const resolutionTransactionId = `legacy_${sha256(JSON.stringify({
          planId: plan.id,
          bucket,
          legacyInventoryHash,
          canonicalInventoryHash: lifecycle.inventoryHash
        }))}`;
        const resolution = commitPlanStorageLegacyResolutionUnderLease(lease, {
          transactionId: resolutionTransactionId,
          status: legacyInventoryHash === lifecycle.inventoryHash
            ? "duplicate_retired"
            : "conflict_quarantined",
          canonicalDirectory: destinationDirectory,
          canonicalInventoryHash: lifecycle.inventoryHash,
          legacyInventoryHash,
          artifacts
        });
        result.receipts.push(resolution.receiptPath);
      });
      result.migrated += 1;
    } catch (error) {
      result.failures.push({ planId: plan.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const canonicalizedCount = canonicalization.migrated + canonicalization.recovered;
  const legacyFailureCount = result.failures.length - failuresBeforeLegacyFiles;
  const reconciliation = reconcileRolePlanStorageConflicts(roleDir);
  result.reconciled = reconciliation.reconciled;
  result.alreadyReconciled = reconciliation.alreadyReconciled;
  result.receipts.push(...reconciliation.receipts);
  result.failures.push(...reconciliation.conflicts.map(({ planId, error }) => ({ planId, error })));
  result.migrated += backfillCanonicalPlanHistories(roleDir, dependencies, result.failures);
  const migratedLegacyFiles = result.migrated - canonicalizedCount - recoveredLegacyCount;
  result.skipped = Math.max(0, legacyFiles.length - migratedLegacyFiles - legacyFailureCount);
  if (result.migrated || result.reconciled) dependencies.onChanged?.();
  return result;
}
