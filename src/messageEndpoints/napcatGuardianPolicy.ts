import { NapcatState } from "../shared/napcatStateContract.js";

/**
 * Runtime guardian policy for NapCat instances.
 *
 * `autoLoginNapcatInstancesOnRabiStart` only ever ran once, on Manager startup. If an
 * instance died afterwards, nothing brought it back: on 2026-09-18 instance napcat-1
 * exited at 12:44 and stayed down past 13:46 even though the Route gateway kept
 * listening. This policy turns that one-shot startup attempt into a repeating check.
 */

/** Consecutive unhealthy observations required before relaunching. */
export const NAPCAT_GUARDIAN_FAILURE_THRESHOLD = 3;
/** Minimum spacing between two automatic relaunch attempts for one instance. */
export const NAPCAT_GUARDIAN_RELAUNCH_COOLDOWN_MS = 5 * 60_000;
/** How long to let a fresh launch settle before judging it again. */
export const NAPCAT_GUARDIAN_LAUNCH_GRACE_MS = 90_000;

/**
 * States where a relaunch is the correct automatic response: the process is gone or its
 * transport is down. Every state that needs a human (QR login, conflict, account in use
 * elsewhere, mismatch) is deliberately absent — those must be reported, never retried.
 */
const NAPCAT_RELAUNCHABLE_STATES = new Set<string>([
  NapcatState.Unreachable,
  NapcatState.Offline,
  NapcatState.StartFailed,
  NapcatState.StartTimeout,
  NapcatState.OnebotNotReady,
  NapcatState.ProcessOrPortAlreadyPresent
]);

export type NapcatGuardianObservation = {
  /** Health state reported by the NapCat manager for this instance. */
  state: string;
  /** True when the instance is confirmed usable; never inferred from the absence of errors. */
  healthy: boolean;
  /** The check needs a human (QR login, conflict, mismatched account). */
  needsUserAction?: boolean;
};

export type NapcatGuardianInstanceState = {
  consecutiveFailures: number;
  lastRelaunchAt?: number;
  /** Last observed state, for reporting what the guardian actually saw. */
  lastState?: string;
  lastMessage?: string;
  /** Set when the guardian stopped retrying and is waiting for a human. */
  awaitingUserAction?: string;
};
export type NapcatGuardianDecision =
  | { action: "healthy"; reason: string }
  | { action: "observe"; reason: string }
  | { action: "relaunch"; reason: string; failures: number }
  | { action: "cooldown"; reason: string }
  | { action: "await-user"; reason: string };

/**
 * Decides what the guardian should do for one instance on one observation tick.
 * Pure on purpose: the relaunch threshold, cooldown and the "never fight a human" rules
 * are the parts most worth pinning down in tests.
 */
export function napcatGuardianDecision(input: Readonly<{
  observation: NapcatGuardianObservation;
  history: NapcatGuardianInstanceState;
  now: number;
  failureThreshold?: number;
  relaunchCooldownMs?: number;
}>): NapcatGuardianDecision {
  const { observation, history, now } = input;
  const threshold = Math.max(1, Math.floor(input.failureThreshold ?? NAPCAT_GUARDIAN_FAILURE_THRESHOLD));
  const cooldownMs = Math.max(0, Math.floor(input.relaunchCooldownMs ?? NAPCAT_GUARDIAN_RELAUNCH_COOLDOWN_MS));

  if (observation.healthy) {
    return { action: "healthy", reason: "实例健康。" };
  }
  if (observation.needsUserAction === true) {
    // Login conflicts and QR logins are real user work; retrying cannot fix them and
    // could fight an operator who is already signing in.
    return {
      action: "await-user",
      reason: `需要人工处理（${observation.state}），看护不再自动重试。`
    };
  }
  // A previous relaunch already concluded that a human must finish the login. Restarting
  // the process again cannot resolve that and would keep interrupting the operator.
  if (history.awaitingUserAction) {
    return { action: "await-user", reason: history.awaitingUserAction };
  }
  if (!NAPCAT_RELAUNCHABLE_STATES.has(observation.state)) {
    return {
      action: "observe",
      reason: `状态 ${observation.state} 不在自动拉起范围内，本轮仅记录。`
    };
  }
  if (history.consecutiveFailures + 1 < threshold) {
    return {
      action: "observe",
      reason: `连续异常 ${history.consecutiveFailures + 1}/${threshold} 次，未达拉起阈值。`
    };
  }
  const lastRelaunchAt = history.lastRelaunchAt;
  if (typeof lastRelaunchAt === "number" && Number.isFinite(lastRelaunchAt)) {
    const elapsed = now - lastRelaunchAt;
    if (elapsed < cooldownMs) {
      return {
        action: "cooldown",
        reason: `距上次自动拉起仅 ${Math.max(0, Math.round(elapsed / 1000))} 秒，仍在冷却期内。`
      };
    }
  }
  return {
    action: "relaunch",
    reason: `连续异常 ${history.consecutiveFailures + 1} 次达到阈值，自动重新拉起。`,
    failures: history.consecutiveFailures + 1
  };
}

/** Applies one decision to the instance history, returning the next history. */
export function napcatGuardianNextState(
  history: NapcatGuardianInstanceState,
  decision: NapcatGuardianDecision,
  observation: NapcatGuardianObservation,
  now: number
): NapcatGuardianInstanceState {
  const base: NapcatGuardianInstanceState = {
    ...history,
    lastState: observation.state
  };
  switch (decision.action) {
    case "healthy":
      return { ...base, consecutiveFailures: 0, awaitingUserAction: undefined };
    case "relaunch":
      return { ...base, consecutiveFailures: 0, lastRelaunchAt: now, awaitingUserAction: undefined };
    case "await-user":
      return { ...base, consecutiveFailures: 0, awaitingUserAction: decision.reason };
    // A cooling-down instance keeps its failure count so the next tick can relaunch.
    case "cooldown":
      return base;
    case "observe":
      return { ...base, consecutiveFailures: history.consecutiveFailures + 1 };
  }
}
