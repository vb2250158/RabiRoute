import assert from "node:assert/strict";
import test from "node:test";
import {
  napcatGuardianDecision,
  napcatGuardianNextState,
  NAPCAT_GUARDIAN_FAILURE_THRESHOLD,
  type NapcatGuardianInstanceState
} from "./napcatGuardianPolicy.js";
import { runNapcatGuardianLoop, type NapcatGuardianDeps } from "./napcatGuardian.js";
import { NapcatState } from "../shared/napcatStateContract.js";

const NOW = 1_800_000_000_000;
const fresh: NapcatGuardianInstanceState = { consecutiveFailures: 0 };

test("a healthy instance resets the failure streak and is never relaunched", () => {
  const decision = napcatGuardianDecision({
    observation: { state: NapcatState.Ready, healthy: true },
    history: { consecutiveFailures: 5 },
    now: NOW
  });
  assert.equal(decision.action, "healthy");
  assert.equal(napcatGuardianNextState({ consecutiveFailures: 5 }, decision, { state: NapcatState.Ready, healthy: true }, NOW).consecutiveFailures, 0);
});

test("an unreachable instance is only relaunched after the sustained threshold", () => {
  const observation = { state: NapcatState.Unreachable, healthy: false };
  let history = fresh;
  // Regression: 2026-09-18 napcat-1 exited at 12:44 and was still down at 13:46.
  for (let attempt = 1; attempt < NAPCAT_GUARDIAN_FAILURE_THRESHOLD; attempt += 1) {
    const decision = napcatGuardianDecision({ observation, history, now: NOW });
    assert.equal(decision.action, "observe", `attempt ${attempt} must still be observing`);
    history = napcatGuardianNextState(history, decision, observation, NOW);
  }
  const decision = napcatGuardianDecision({ observation, history, now: NOW });
  assert.equal(decision.action, "relaunch");
  const after = napcatGuardianNextState(history, decision, observation, NOW);
  assert.equal(after.consecutiveFailures, 0);
  assert.equal(after.lastRelaunchAt, NOW);
});

test("states that need a human are reported, never auto-retried", () => {
  for (const state of [NapcatState.QrLoginRequired, NapcatState.LoginConflict, NapcatState.AccountMismatch, NapcatState.AccountOnlineElsewhere]) {
    const decision = napcatGuardianDecision({
      observation: { state, healthy: false, needsUserAction: true },
      history: { consecutiveFailures: 99 },
      now: NOW
    });
    assert.equal(decision.action, "await-user", `${state} must wait for a human`);
  }
  // An account already online elsewhere must not be double-started even without the flag.
  const owned = napcatGuardianDecision({
    observation: { state: NapcatState.AccountOnlineElsewhere, healthy: false },
    history: { consecutiveFailures: 99 },
    now: NOW
  });
  assert.equal(owned.action, "observe");
});

test("a fresh relaunch is protected by a cooldown window", () => {
  const observation = { state: NapcatState.Unreachable, healthy: false };
  const decision = napcatGuardianDecision({
    observation,
    history: { consecutiveFailures: NAPCAT_GUARDIAN_FAILURE_THRESHOLD - 1, lastRelaunchAt: NOW - 10_000 },
    now: NOW
  });
  assert.equal(decision.action, "cooldown");
  // Once the cooldown lapses the same history may relaunch again.
  const later = napcatGuardianDecision({
    observation,
    history: { consecutiveFailures: NAPCAT_GUARDIAN_FAILURE_THRESHOLD - 1, lastRelaunchAt: NOW - 10 * 60_000 },
    now: NOW
  });
  assert.equal(later.action, "relaunch");
});

test("the guardian loop relaunches a persistently down instance and then stops on abort", async () => {
  const controller = new AbortController();
  const relaunches: Array<{ gatewayId: string; instanceId: string }> = [];
  const logs: string[] = [];
  let now = NOW;
  const deps: NapcatGuardianDeps = {
    listInstances: () => [{ gatewayId: "route-1", instanceId: "napcat-1" }],
    // Observe a dead instance every tick.
    observe: async () => ({ state: NapcatState.Unreachable, healthy: false }),
    relaunch: async request => {
      relaunches.push(request);
      return { ok: true, state: NapcatState.Ready };
    },
    now: () => now,
    // Drive ticks without real time and stop after the relaunch has been observed.
    sleep: async () => {
      now += 60_000;
      if (relaunches.length > 0) controller.abort();
    },
    log: message => logs.push(message)
  };

  const ticks = await runNapcatGuardianLoop(deps, controller.signal);
  assert.ok(ticks >= 1);
  assert.equal(relaunches.length, 1, "a down instance must be relaunched exactly once within the cooldown");
  assert.deepEqual(relaunches[0], { gatewayId: "route-1", instanceId: "napcat-1" });
  assert.ok(logs.some(message => message.includes("重新拉起")), "the relaunch must be observable in the log");
});

test("the guardian loop never relaunches a healthy instance", async () => {
  const controller = new AbortController();
  let relaunches = 0;
  let ticks = 0;
  const deps: NapcatGuardianDeps = {
    listInstances: () => [{ gatewayId: "route-1", instanceId: "napcat-1" }],
    observe: async () => ({ state: NapcatState.Ready, healthy: true }),
    relaunch: async () => { relaunches += 1; return { ok: true }; },
    sleep: async () => { if (++ticks >= 3) controller.abort(); }
  };
  await runNapcatGuardianLoop(deps, controller.signal);
  assert.equal(relaunches, 0);
});

test("an observation error counts as a failure, not as health", async () => {
  const controller = new AbortController();
  let relaunches = 0;
  let ticks = 0;
  const deps: NapcatGuardianDeps = {
    listInstances: () => [{ gatewayId: "route-1", instanceId: "napcat-1" }],
    observe: async () => { throw new Error("probe exploded"); },
    relaunch: async () => { relaunches += 1; controller.abort(); return { ok: true }; },
    // Each tick is one failure; the third must relaunch.
    sleep: async () => { ticks += 1; }
  };
  await runNapcatGuardianLoop(deps, controller.signal);
  assert.equal(relaunches, 1);
  assert.ok(ticks >= NAPCAT_GUARDIAN_FAILURE_THRESHOLD - 1);
});

test("a relaunch that still needs a human is reported instead of being retried forever", async () => {
  const controller = new AbortController();
  let relaunches = 0;
  let ticks = 0;
  const logs: string[] = [];
  const deps: NapcatGuardianDeps = {
    listInstances: () => [{ gatewayId: "route-1", instanceId: "napcat-1" }],
    observe: async () => ({ state: NapcatState.Unreachable, healthy: false }),
    relaunch: async () => {
      relaunches += 1;
      // The process started but the account still needs an interactive QR login.
      return { ok: false, state: NapcatState.QrLoginRequired, needsUserAction: true, message: "请扫码登录。" };
    },
    now: () => NOW + relaunches * 20 * 60_000,
    sleep: async () => { if (++ticks >= 6) controller.abort(); },
    log: message => logs.push(message)
  };
  await runNapcatGuardianLoop(deps, controller.signal);
  assert.equal(relaunches, 1, "a pending scan-to-login must not be retried on every tick");
  assert.ok(logs.some(message => message.includes("扫码") || message.includes("人工")), "the user action must be reported");
});
