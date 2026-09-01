import { createHash } from "node:crypto";

/**
 * Memory ids remain logical identities. This segment is only the legacy
 * physical filename projection and is intentionally treated as lossy.
 */
export function safeMemoryStorageSegment(value: unknown): string {
  const cleaned = String(value ?? "")
    .trim()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return Array.from(cleaned).slice(0, 80).join("");
}

/**
 * Conservative, locale-independent approximation of Windows ordinal
 * case-insensitive path identity. Over-collisions fail closed; under-collisions
 * could overwrite another logical memory on Windows or a shared SMB volume.
 */
export function memoryStorageCaseFold(value: unknown): string {
  return String(value ?? "").normalize("NFC").toUpperCase().normalize("NFC");
}

/**
 * Windows and shared NAS paths must agree on which logical ids can alias one
 * physical filename. Callers must compare the original ids after matching it.
 */
export function memoryStorageCollisionKey(value: unknown, fallback: string): string {
  return memoryStorageCaseFold(safeMemoryStorageSegment(value) || fallback);
}

/**
 * Every mutation in one role's memory catalog shares this repository lease.
 * A digest keeps the synthetic lease identity out of the normal plan-id space.
 */
export const ROLE_MEMORY_CATALOG_LEASE_ID = `storage-${createHash("sha256")
  .update("io.rabiroute.role-memory-catalog@1", "utf8")
  .digest("hex")}`;
