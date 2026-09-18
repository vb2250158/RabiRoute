import type { NapcatManagerContext } from "./napcatManager.js";
import {
  napcatGuardianDecision,
  napcatGuardianNextState,
  NAPCAT_GUARDIAN_FAILURE_THRESHOLD,
  NAPCAT_GUARDIAN_LAUNCH_GRACE_MS,
  NAPCAT_GUARDIAN_RELAUNCH_COOLDOWN_MS,
  type NapcatGuardianDecision,
  type NapcatGuardianInstanceState
} from "./napcatGuardianPolicy.js";
import { NapcatState } from "../shared/napcatStateContract.js";

/**
 * Keeps enabled NapCat instances alive after Manager startup.
 *
 * The startup auto-login only ran once, so an instance that exited mid-run stayed down
 * indefinitely. This guardian re-observes each enabled instance on an interval and
 * relaunches only after a sustained failure threshold, reusing the existing launch
 * semantics (including the account-owner protection) rather than bypassing them.
 */
export type NapcatGuardianObservationPort = (input: {
  gatewayId: string;
  instanceId: string;
}) => Promise<{ state: string; healthy: boolean; needsUserAction?: boolean; message?: string }>;

export type NapcatGuardianRelaunchPort = (input: {
  gatewayId: string;
  instanceId: string;
}) => Promise<{ ok?: boolean; state?: string; needsUserAction?: boolean; message?: string }>;

export type NapcatGuardianDeps = {
  observe: NapcatGuardianObservationPort;
  relaunch: NapcatGuardianRelaunchPort;
  /** Enabled instances the guardian owns, in a stable order. */
  listInstances: () => Array<{ gatewayId: string; instanceId: string }>;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  log?: (message: string) => void;
  failureThreshold?: number;
  relaunchCooldownMs?: number;
  launchGraceMs?: number;
  intervalMs?: number;
};

export const NAPCAT_GUARDIAN_INTERVAL_MS = 30_000;

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>(resolve => {
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Runs the guardian loop until `signal` aborts. Returns the number of ticks completed,
 * which keeps the loop's termination observable to callers and tests.
 */
export async function runNapcatGuardianLoop(deps: NapcatGuardianDeps, signal: AbortSignal): Promise<number> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? abortableSleep;
  const intervalMs = Math.max(1_000, Math.floor(deps.intervalMs ?? NAPCAT_GUARDIAN_INTERVAL_MS));
  const graceMs = Math.max(0, Math.floor(deps.launchGraceMs ?? NAPCAT_GUARDIAN_LAUNCH_GRACE_MS));
  const history = new Map<string, NapcatGuardianInstanceState>();
  let ticks = 0;

  while (!signal.aborted) {
    ticks += 1;
    let graceWaitMs = 0;
    for (const { gatewayId, instanceId } of deps.listInstances()) {
      if (signal.aborted) break;
      const key = `${gatewayId}\u0000${instanceId}`;
      const previous = history.get(key) ?? { consecutiveFailures: 0 };
      let observation: Awaited<ReturnType<NapcatGuardianObservationPort>>;
      try {
        observation = await deps.observe({ gatewayId, instanceId });
      } catch (error) {
        // An observation error is a failed probe, never a healthy verdict.
        observation = {
          state: NapcatState.Unreachable,
          healthy: false,
          message: error instanceof Error ? error.message : String(error)
        };
      }
      if (signal.aborted) break;

      const decision = napcatGuardianDecision({
        observation,
        history: previous,
        now: now(),
        failureThreshold: deps.failureThreshold,
        relaunchCooldownMs: deps.relaunchCooldownMs
      });
      let next = napcatGuardianNextState(previous, decision, observation, now());

      if (decision.action === "relaunch") {
        deps.log?.(`NapCat 看护：${decision.reason}`);
        try {
          const result = await deps.relaunch({ gatewayId, instanceId });
          const state = String(result.state || "");
          const message = result.message ? ` (${result.message})` : "";
          deps.log?.(`NapCat 看护：重新拉起 ${gatewayId}/${instanceId} → ${state || "unknown"}${message}`);
          next = {
            ...next,
            lastState: state || next.lastState,
            lastMessage: result.message,
            awaitingUserAction: result.needsUserAction === true
              // A relaunched instance that still needs a human (for example a QR login)
              // must be reported as such instead of being retried forever.
              ? (result.message || "自动拉起后仍需要人工完成登录。")
              : undefined
          };
          if (result.ok !== true && result.needsUserAction !== true) {
            // Keep the failure streak so the next tick can retry after the cooldown.
            next = { ...next, consecutiveFailures: decision.failures };
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          deps.log?.(`NapCat 看护：重新拉起 ${gatewayId}/${instanceId} 失败：${message}`);
          next = { ...next, consecutiveFailures: decision.failures, lastMessage: message };
        }
        graceWaitMs = Math.max(graceWaitMs, graceMs);
      } else if (decision.action === "await-user") {
        if (previous.awaitingUserAction !== decision.reason) {
          deps.log?.(`NapCat 看护：${gatewayId}/${instanceId} ${decision.reason}`);
        }
      }

      history.set(key, next);
    }
    if (signal.aborted) break;
    // Give a fresh launch time to reach readiness before judging it again.
    await sleep(Math.max(intervalMs, graceWaitMs), signal);
  }
  return ticks;
}

/** Builds guardian dependencies bound to a live NapCat manager context. */
export function napcatGuardianDepsFor(
  ctx: NapcatManagerContext,
  ports: {
    observe: NapcatGuardianObservationPort;
    relaunch: NapcatGuardianRelaunchPort;
    listInstances: () => Array<{ gatewayId: string; instanceId: string }>;
  }
): NapcatGuardianDeps {
  return {
    observe: ports.observe,
    relaunch: ports.relaunch,
    listInstances: ports.listInstances,
    log: message => {
      for (const runtime of ctx.getRuntimes()) ctx.appendLog(runtime, message);
    },
    failureThreshold: NAPCAT_GUARDIAN_FAILURE_THRESHOLD,
    relaunchCooldownMs: NAPCAT_GUARDIAN_RELAUNCH_COOLDOWN_MS
  };
}
