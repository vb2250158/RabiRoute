import path from "node:path";
import {
  commitPlanStoragePackage,
  recoverPlanStoragePackageTransactions,
  type PlanStorageBucket,
  type PlanStoragePackageCommitResult
} from "./planStorageRepository.js";
import {
  decodePersonaSyncPlanPackageV1,
  type PersonaSyncActivePlanPackageCommand,
  type PersonaSyncArchivedPlanPackageCommand
} from "./personaSyncPlanPackageV1Codec.js";
import { archivedPlanDirectoryDominatesActive } from "./planStoragePolicy.js";

export type PersonaSyncPlanPackageResult = {
  status: "applied" | "unchanged" | "conflict";
  roleId: string;
  planId: string;
  storageId: string;
  inventoryHash: string;
  reason?: string;
  currentInventoryHash?: string;
  quarantinePath?: string;
  receiptPath?: string;
};

export type PersonaSyncPlanPackageRecoveryReport = {
  results: PersonaSyncPlanPackageResult[];
  errors: Array<{ receiptPath: string; message: string }>;
};

function transactionId(bucket: PlanStorageBucket, inventoryHash: string): string {
  return `persona_sync_${bucket}_${inventoryHash}`;
}

function packageResult(
  roleId: string,
  planId: string,
  storageId: string,
  inventoryHash: string,
  committed: PlanStoragePackageCommitResult
): PersonaSyncPlanPackageResult {
  return {
    status: committed.status,
    roleId,
    planId,
    storageId,
    inventoryHash,
    reason: committed.reason,
    currentInventoryHash: committed.currentInventoryHash,
    quarantinePath: committed.quarantinePath,
    receiptPath: committed.receiptPath
  };
}

function applyPlanPackage(
  roleDir: string,
  command: PersonaSyncArchivedPlanPackageCommand,
  bucket: PlanStorageBucket
): PersonaSyncPlanPackageResult {
  const decoded = decodePersonaSyncPlanPackageV1(command);
  const expectedRoleId = path.basename(path.resolve(roleDir));
  if (decoded.roleId !== expectedRoleId) {
    throw new Error(`Persona sync plan package role does not match its destination: ${decoded.roleId}`);
  }
  const committed = commitPlanStoragePackage({
    roleDir,
    planId: decoded.planId,
    storageId: decoded.storageId,
    bucket,
    inventoryHash: decoded.inventoryHash,
    files: decoded.files,
    transactionId: transactionId(bucket, decoded.inventoryHash),
    archiveDominatesActive: bucket === "archive" ? archivedPlanDirectoryDominatesActive : undefined
  });
  return packageResult(
    decoded.roleId,
    decoded.planId,
    decoded.storageId,
    decoded.inventoryHash,
    committed
  );
}

export function applyActivePlanPackage(
  roleDir: string,
  command: PersonaSyncActivePlanPackageCommand
): PersonaSyncPlanPackageResult {
  return applyPlanPackage(roleDir, command, "active");
}

export function applyArchivedPlanPackage(
  roleDir: string,
  command: PersonaSyncArchivedPlanPackageCommand
): PersonaSyncPlanPackageResult {
  return applyPlanPackage(roleDir, command, "archive");
}

export function recoverPersonaSyncPlanPackageTransactions(
  roleDir: string
): PersonaSyncPlanPackageRecoveryReport {
  const recovered = recoverPlanStoragePackageTransactions(roleDir, {
    archiveDominatesActive: archivedPlanDirectoryDominatesActive
  });
  const roleId = path.basename(path.resolve(roleDir));
  return {
    results: recovered.results.map((result) => packageResult(
      roleId,
      result.planId,
      result.storageId,
      result.inventoryHash,
      result
    )),
    errors: recovered.failures.map((failure) => ({
      receiptPath: failure.transactionPath,
      message: failure.error
    }))
  };
}
