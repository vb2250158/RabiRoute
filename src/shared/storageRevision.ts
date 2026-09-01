import { createHash, randomUUID } from "node:crypto";

export type StorageMutationStamp = Readonly<{
  requestId: string;
  revision: string;
}>;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function createStorageRevision(): string {
  return randomUUID();
}

export function storageMutationRevision(requestId: string): string {
  const normalized = String(requestId || "").trim();
  if (!normalized) throw new Error("Storage mutation requestId is required for a deterministic revision.");
  return `mutation-${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
}

export function storageRevisionToken(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value && typeof value === "object") {
    const revision = String((value as { storageRevision?: unknown }).storageRevision ?? "").trim();
    if (/^[A-Za-z0-9._:-]{1,200}$/.test(revision)) return `revision:${revision}`;
  }
  return `legacy-sha256:${createHash("sha256").update(stableJson(value), "utf8").digest("hex")}`;
}

export function storageInventoryRevisionToken(inventoryHash: string): string {
  const normalized = String(inventoryHash || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error("Storage inventory hash is invalid.");
  return `inventory-sha256:${normalized}`;
}
