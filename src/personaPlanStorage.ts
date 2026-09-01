import fs from "node:fs";
import path from "node:path";
import {
  canonicalPlanStorageIdentity,
  canonicalPlanStorageName,
  type PlanStorageBucket
} from "./planStorageLayout.js";
import {
  canonicalHistoricalPlanStorageCollisionKey,
  canonicalLogicalPlanId,
  canonicalPlanStorageCollisionKey,
  windowsPlanStoragePathCollisionKey
} from "./planStorageIdentity.js";

const PLAN_FILE = "plan.json";

export type PersonaPlanStoragePath = {
  storageId: string;
  bucket: PlanStorageBucket;
};

function readPlan(filePath: string): Record<string, unknown> {
  const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Plan storage JSON must contain an object: ${filePath}`);
  }
  return value as Record<string, unknown>;
}

type LocatedPersonaPlan = {
  bucket: PlanStorageBucket;
  storageId: string;
  planId: string;
  plan: Record<string, unknown>;
};

function plansForStorageCollision(
  roleDir: string,
  storageIdentity: string,
  buckets: readonly PlanStorageBucket[]
): LocatedPersonaPlan[] {
  const collisionId = canonicalPlanStorageCollisionKey(storageIdentity);
  const matches: LocatedPersonaPlan[] = [];
  for (const bucket of buckets) {
    const bucketRoot = path.join(roleDir, "plans", bucket);
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(bucketRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const entry of entries) {
      const entryCollisionMatches = windowsPlanStoragePathCollisionKey(entry.name) === collisionId
        || canonicalHistoricalPlanStorageCollisionKey(entry.name) === collisionId;
      if (!entryCollisionMatches) continue;
      const directory = path.join(bucketRoot, entry.name);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error(`Plan storage identity is occupied by a non-directory entry: ${entry.name}`);
      }
      const planFile = path.join(directory, PLAN_FILE);
      if (!fs.existsSync(planFile)) {
        throw new Error(`Plan storage directory is missing plan.json: ${entry.name}`);
      }
      const plan = readPlan(planFile);
      const planId = canonicalLogicalPlanId(String(plan.id || ""));
      if (canonicalPlanStorageIdentity(planId) !== entry.name
        || canonicalPlanStorageCollisionKey(planId) !== collisionId) {
        throw new Error(`Plan storage directory does not match plan.json id: ${entry.name}`);
      }
      matches.push({ bucket, storageId: entry.name, planId, plan });
    }
  }
  // Return the actual owner rather than dereferencing the caller's alias path;
  // package validation can then reject a distinct logical id before writing.
  return matches;
}

/**
 * Recognizes only the canonical online plan layout.
 * Historical paths belong to the startup migration boundary and are never a
 * Persona Sync protocol variant.
 */
export function personaPlanStoragePath(relativePath: string): PersonaPlanStoragePath | null {
  const normalized = String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const match = normalized.match(/^plans\/(active|archive)\/([^/]+)\/(?:.+)$/i);
  if (!match) return null;
  const storageId = canonicalLogicalPlanId(match[2]!);
  if (canonicalPlanStorageName(storageId) !== storageId) {
    throw new Error(`Persona sync plan path uses a non-canonical storage identity: ${storageId}`);
  }
  return {
    bucket: match[1]!.toLowerCase() as PlanStorageBucket,
    storageId
  };
}

export function canonicalPlanIdForStorageIdentity(roleDir: string, storageIdentity: string): string | null {
  const ids = new Set(plansForStorageCollision(roleDir, storageIdentity, ["active", "archive"])
    .map(match => match.planId));
  if (ids.size > 1) {
    throw new Error(`Plan storage identity collision across buckets: ${[...ids].sort().join(" and ")}`);
  }
  return [...ids][0] ?? null;
}

export function archivedPlanStorageFence(
  roleDir: string,
  storageIdentity: string
): { status: "absent" | "archived" | "invalid"; planId?: string; reason?: string } {
  const storageId = canonicalPlanStorageName(storageIdentity);
  try {
    const matches = plansForStorageCollision(roleDir, storageIdentity, ["archive"]);
    if (matches.length === 0) return { status: "absent" };
    if (matches.length !== 1) {
      return { status: "invalid", reason: "archive_plan_identity_collision" };
    }
    const { planId, plan, storageId: storedStorageId } = matches[0]!;
    if (storedStorageId !== storageId) {
      return { status: "invalid", reason: "archive_plan_identity_mismatch" };
    }
    if (plan.status !== "已归档") {
      return { status: "invalid", planId, reason: "archive_bucket_contains_non_archived_plan" };
    }
    return { status: "archived", planId };
  } catch (error) {
    return { status: "invalid", reason: error instanceof Error ? error.message : String(error) };
  }
}

export function canonicalArchivedPlanExists(roleDir: string, storageIdentity: string): boolean {
  return archivedPlanStorageFence(roleDir, storageIdentity).status === "archived";
}
