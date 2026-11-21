import { createHash } from "node:crypto";
import { planBindingSourceKey, type PlanBindingSource } from "./planBindingOwner.js";

/** Presentation streams never need the original session, turn, or tool IDs. */
export function desktopPetWorkKey(...parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function desktopPetWorkSessionKey(source: PlanBindingSource): string {
  return desktopPetWorkKey(planBindingSourceKey(source));
}
