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

test("a dead process releases a previous human wait without bypassing threshold or cooldown", () => {
  const history = { consecutiveFailures: 0, awaitingUserAction: "请扫码", lastRelaunchAt: NOW - 600_000 };
  const unknown = { state: NapcatState.Unreachable, healthy: false };
  assert.equal(napcatGuardianDecision({ observation: unknown, history, now: NOW }).action, "await-user");
  const absent = { ...unknown, processAbsent: true };
  const decision = napcatGuardianDecision({ observation: absent, history, now: NOW });
  assert.equal(decision.action, "observe");
  const next = napcatGuardianNextState(history, decision, absent, NOW);
  assert.equal(next.awaitingUserAction, undefined);
  assert.equal(next.consecutiveFailures, 1);
  assert.equal(napcatGuardianDecision({ observation: absent, history: { ...next, consecutiveFailures: 2 }, now: NOW }).action, "relaunch");
  assert.equal(napcatGuardianDecision({ observation: absent, history: { ...next, consecutiveFailures: 2, lastRelaunchAt: NOW - 10_000 }, now: NOW }).action, "cooldown");
});

test("guardian waits for a live QR process but recovers it after confirmed exit", async () => {
  const controller = new AbortController();
  let ticks = 0;
  let relaunches = 0;
  const observed = [
    { state: NapcatState.Unreachable, healthy: false },
    { state: NapcatState.QrLoginRequired, healthy: false, needsUserAction: true },
    { state: NapcatState.Unreachable, healthy: false, processAbsent: false },
    { state: NapcatState.Unreachable, healthy: false, processAbsent: true }
  ];
  await runNapcatGuardianLoop({
    listInstances: () => [{ gatewayId: "route", instanceId: "bot" }],
    observe: async () => observed[Math.min(ticks, observed.length - 1)]!,
    relaunch: async () => { relaunches++; controller.abort(); return { ok: true }; },
    sleep: async () => { ticks++; if (ticks > 8) controller.abort(); },
    now: () => NOW + ticks * 60_000
  }, controller.signal);
  assert.equal(relaunches, 1);
  assert.equal(ticks, 5, "three confirmed dead observations are still required after the live-human wait");
});

test("saved quick-login availability is recoverable, not a human stop", () => {
  assert.equal(napcatGuardianDecision({ observation: { state: NapcatState.QuickLoginAvailable, healthy: false },
    history: { consecutiveFailures: 2 }, now: NOW }).action, "relaunch");
});

test("a human wait releases only on new explicit automatic recovery evidence", () => {
  const history = { consecutiveFailures: 0, awaitingUserAction: "请扫码", lastRelaunchAt: NOW - 600_000 };
  for (const observation of [
    { state: NapcatState.QuickLoginAvailable, healthy: false },
    { state: NapcatState.OnebotNotReady, healthy: false, boundAccountLoggedIn: true }
  ]) {
    const decision = napcatGuardianDecision({ observation, history, now: NOW });
    assert.equal(decision.action, "observe");
    const next = napcatGuardianNextState(history, decision, observation, NOW);
    assert.equal(next.awaitingUserAction, undefined);
    assert.equal(next.consecutiveFailures, 1);
    assert.equal(napcatGuardianDecision({ observation, history: { ...next, consecutiveFailures: 2 }, now: NOW }).action, "relaunch");
    assert.equal(napcatGuardianDecision({ observation, history: { ...next, consecutiveFailures: 2, lastRelaunchAt: NOW - 1000 }, now: NOW }).action, "cooldown");
    assert.equal(napcatGuardianDecision({ observation: { ...observation, needsUserAction: true }, history, now: NOW }).action, "await-user");
  }
  for (const state of [NapcatState.Unreachable, NapcatState.OnebotNotReady, NapcatState.Offline]) {
    const observation = { state, healthy: false };
    const decision = napcatGuardianDecision({ observation, history, now: NOW });
    assert.equal(decision.action, "await-user", "unreachable or unverified transport never interrupts a pending scan");
    assert.equal(napcatGuardianNextState(history, decision, observation, NOW).awaitingUserAction, history.awaitingUserAction);
  }
});

test("guardian resumes after a list failure and throwing logger on bounded observation ticks", async () => {
  const controller = new AbortController();
  let lists = 0;
  let sleeps = 0;
  let observations = 0;
  let relaunches = 0;
  await runNapcatGuardianLoop({
    listInstances: () => { if (++lists === 1) throw new Error("temporary list failure"); return [{ gatewayId: "route", instanceId: "bot" }]; },
    observe: async () => { observations++; return { state: NapcatState.Unreachable, healthy: false }; },
    relaunch: async () => { relaunches++; return { ok: false, state: NapcatState.QrLoginRequired, needsUserAction: true }; },
    log: () => { throw new Error("temporary log failure"); },
    sleep: async (ms) => { assert.ok(ms >= 30_000); if (++sleeps === 5) controller.abort(); }
  }, controller.signal);
  assert.equal(lists, 5);
  assert.equal(observations, 4);
  assert.equal(relaunches, 1, "logger failure must not lose the relaunch's human-wait result");
});

test("guardian abort cancels its default interval after a list failure", async () => {
  const controller = new AbortController();
  const abort = setTimeout(() => controller.abort(), 10);
  try {
    const ticks = await runNapcatGuardianLoop({
      listInstances: () => { throw new Error("temporary list failure"); },
      observe: async () => { throw new Error("must not observe"); },
      relaunch: async () => { throw new Error("must not relaunch"); },
      log: () => { throw new Error("temporary log failure"); }
    }, controller.signal);
    assert.equal(ticks, 1);
  } finally { clearTimeout(abort); }
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
