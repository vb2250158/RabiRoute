import path from "node:path";
import { randomUUID } from "node:crypto";

/** Process-local commit fencing; only invalidation evidence, never plan truth. */
export type PlanReadFence = { epoch: string; revision: number; fullRevision: number; changes: Array<{ planId: string; revision: number }> };
const epoch = randomUUID();
const roles = new Map<string, PlanReadFence>();
const MAX_CHANGED_PLANS = 1024;
export function planReadFence(roleDir: string): PlanReadFence {
  const key = path.resolve(roleDir);
  let state = roles.get(key);
  if (!state) { state = { epoch, revision: 0, fullRevision: 0, changes: [] }; roles.set(key,state); }
  return { ...state, changes: state.changes.map(change => ({ ...change })) };
}
export function invalidatePlanReads(roleDir: string, planId?: string): void {
  const state = planReadFence(roleDir);
  state.revision++;
  if (!planId || state.changes.length >= MAX_CHANGED_PLANS) { state.fullRevision = state.revision; state.changes = []; }
  else { state.changes = state.changes.filter(change => change.planId !== planId); state.changes.push({ planId, revision: state.revision }); }
  roles.set(path.resolve(roleDir),state);
}
