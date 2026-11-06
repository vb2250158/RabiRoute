import assert from "node:assert/strict";
import test from "node:test";
import {
  applyWeixinPollFailure,
  applyWeixinPollSuccess,
  describeWeixinStartup
} from "./weixinSessionLifecycle.js";
import type { WeixinOpenClawState } from "../weixinOpenClaw.js";
import { WeixinHttpError } from "../weixinOpenClaw.js";

function recoverableState(): WeixinOpenClawState {
  return {
    token: "secret-token",
    baseUrl: "https://api.example.invalid",
    contextTokens: { session: "secret-context" },
    authState: "recoverable",
    credentialsRetained: true,
    updatedAt: new Date(0).toISOString()
  };
}

test("restart with recoverable credentials enters restoring and succeeds without QR", () => {
  const state = recoverableState();
  assert.deepEqual(describeWeixinStartup(state), {
    phase: "restoring",
    loggedIn: false,
    credentialsRetained: true,
    loginRequired: false
  });

  const restored = applyWeixinPollSuccess(state, new Date("2026-07-31T00:00:00.000Z"));
  assert.equal(restored.state.token, "secret-token");
  assert.equal(restored.status.phase, "restored");
  assert.equal(restored.status.loggedIn, true);
  assert.equal(restored.status.loginRequired, false);
});

test("temporary network failure retains credentials and does not request QR", () => {
  const state = recoverableState();
  const result = applyWeixinPollFailure(state, new Error("network timeout"));
  assert.equal(result.state.token, "secret-token");
  assert.deepEqual(result.state.contextTokens, { session: "secret-context" });
  assert.equal(result.status.phase, "temporarily_unreachable");
  assert.equal(result.status.credentialsRetained, true);
  assert.equal(result.status.loginRequired, false);
});

test("explicit server session timeout invalidates credentials and requires QR", () => {
  const state = recoverableState();
  const result = applyWeixinPollFailure(state, { ret: -14, errcode: -14, errmsg: "session timeout" });
  assert.equal(result.state.token, undefined);
  assert.deepEqual(result.state.contextTokens, {});
  assert.equal(result.state.authState, "invalid");
  assert.equal(result.status.phase, "invalid");
  assert.equal(result.status.loginRequired, true);
});

test("explicit HTTP authorization rejection invalidates credentials while HTTP 5xx does not", () => {
  const rejected = applyWeixinPollFailure(recoverableState(), new WeixinHttpError(401, "POST", "getupdates"));
  assert.equal(rejected.status.phase, "invalid");
  assert.equal(rejected.state.token, undefined);

  const unavailable = applyWeixinPollFailure(recoverableState(), new WeixinHttpError(503, "POST", "getupdates"));
  assert.equal(unavailable.status.phase, "temporarily_unreachable");
  assert.equal(unavailable.state.token, "secret-token");
  assert.equal(unavailable.status.loginRequired, false);
});

test("first use without stored state is distinct from an invalid session", () => {
  const state: WeixinOpenClawState = {
    baseUrl: "https://api.example.invalid",
    contextTokens: {},
    authState: "never_logged_in",
    credentialsRetained: false,
    updatedAt: new Date(0).toISOString()
  };
  assert.equal(describeWeixinStartup(state).phase, "never_logged_in");
  assert.equal(describeWeixinStartup(state).loginRequired, true);
});
