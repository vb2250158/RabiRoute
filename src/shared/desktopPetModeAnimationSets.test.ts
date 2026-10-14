import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDesktopPetModeAnimationSets, validateDesktopPetModeAnimationSetManifest } from "./desktopPetModeAnimationSets.js";

const states = { idle: { loop: true }, desk: { loop: true }, wave: { loop: false, next: "desk" },
  read: { loop: false, next: "desk" }, attention: { loop: false, next: "idle" } };

test("arbitrary mode IDs own separate looping idle, random and click pools", () => {
  assert.deepEqual(normalizeDesktopPetModeAnimationSets({
    focus: { idleState: "desk", randomIntervalSeconds: { min: 45, max: 120 }, randomStates: ["read", "read"], clickStates: ["wave"] },
    quiet: { idleState: "idle" }
  }, states), {
    focus: { idleState: "desk", randomMinSeconds: 45, randomMaxSeconds: 120, randomStates: ["read"], clickStates: ["wave"] },
    quiet: { idleState: "idle", randomMinSeconds: 90, randomMaxSeconds: 240, randomStates: [], clickStates: [] }
  });
});

test("legacy manifests do not synthesize mode pools", () => {
  assert.deepEqual(normalizeDesktopPetModeAnimationSets(undefined, states), {});
  assert.doesNotThrow(() => validateDesktopPetModeAnimationSetManifest({ states: {}, companionStates: { watch: "desk" } }));
});

test("mode groups reject missing idle, looping gestures and the wrong return pose", () => {
  for (const group of [
    { idleState: "missing" }, { idleState: "desk", randomStates: ["desk"] },
    { idleState: "desk", clickStates: ["attention"] }, { idleState: "desk", randomStates: ["missing"] }
  ]) assert.throws(() => normalizeDesktopPetModeAnimationSets({ focus: group }, states), /modeAnimationSets/);
});

test("mode pools and timing reject malformed metadata before import publication", () => {
  for (const group of [
    { idleState: "desk", clickStates: "wave" },
    { idleState: "desk", randomIntervalSeconds: { min: 1, max: 90 } },
    { idleState: "desk", randomIntervalSeconds: { min: 120, max: 45 } },
    { idleState: "desk", randomIntervalSeconds: { min: 45, max: 4000 } }
  ]) assert.throws(() => normalizeDesktopPetModeAnimationSets({ focus: group }, states), /modeAnimationSets/);
});

test("manifest admission uses inherited loop defaults and exact one-shot next", () => {
  const manifest = { defaults: { loop: true }, states: { desk: {}, wave: { loop: false, next: "desk" } },
    modeAnimationSets: { custom: { idleState: "desk", clickStates: ["wave"] } } };
  assert.doesNotThrow(() => validateDesktopPetModeAnimationSetManifest(manifest));
  assert.throws(() => validateDesktopPetModeAnimationSetManifest({ ...manifest,
    states: { ...manifest.states, wave: { loop: false, next: "idle" } } }), /returning to desk/);
});
