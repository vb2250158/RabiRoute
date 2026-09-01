/**
 * The one logical-id and physical-key contract for plan storage.
 *
 * Runtime entry points must use `canonicalLogicalPlanId` and
 * `canonicalPlanStorageKey`. Historical migration code may use
 * `canonicalHistoricalPlanStorageKey` only to group pre-contract names before
 * publishing a canonical directory.
 */

export function canonicalLogicalPlanId(value: unknown): string {
  const raw = String(value || "");
  const canonical = raw.trim().normalize("NFC");
  if (raw !== canonical) {
    throw new Error(`Plan id must already be trimmed and Unicode NFC-normalized: ${raw}`);
  }
  if (!canonical || canonical === "." || canonical === ".."
    || canonical.includes("/") || canonical.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(canonical)) {
    throw new Error(`Invalid canonical logical plan id: ${raw}`);
  }
  return canonical;
}

export function safePlanStorageSegment(value: unknown): string {
  const cleaned = String(value || "")
    .trim()
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return Array.from(cleaned).slice(0, 100).join("");
}

export function canonicalHistoricalPlanStorageKey(value: unknown): string {
  return (safePlanStorageSegment(value) || "plan").toLocaleLowerCase("en-US");
}

export function canonicalPlanStorageKey(planId: unknown): string {
  return canonicalHistoricalPlanStorageKey(canonicalLogicalPlanId(planId));
}

/**
 * A fail-closed comparison key for paths that may be materialized on a
 * case-insensitive filesystem. This is deliberately independent from the
 * lower-case physical storage key: changing `canonicalPlanStorageKey` would
 * rename every existing plan directory. Upper-casing folds pairs such as the
 * Greek sigma/final-sigma (`σ`/`ς`) that Windows OrdinalIgnoreCase treats as
 * one physical name but JavaScript lower-casing leaves distinct. The folded
 * representative is lowered again so existing ASCII/lower-case lease hashes
 * stay stable. Multi-code-point uppercase expansions (for example `ß` ->
 * `SS`) retain the original character instead of creating an unrelated
 * collision or changing an established lock identity.
 */
export function windowsPlanStoragePathCollisionKey(value: unknown): string {
  const normalized = String(value ?? "").normalize("NFC");
  return Array.from(normalized, character => {
    const upper = character.toUpperCase();
    return Array.from(upper).length === 1 ? upper.toLowerCase() : character;
  }).join("").normalize("NFC");
}

export function canonicalHistoricalPlanStorageCollisionKey(value: unknown): string {
  return windowsPlanStoragePathCollisionKey(canonicalHistoricalPlanStorageKey(value));
}

export function canonicalPlanStorageCollisionKey(planId: unknown): string {
  return windowsPlanStoragePathCollisionKey(canonicalPlanStorageKey(planId));
}
