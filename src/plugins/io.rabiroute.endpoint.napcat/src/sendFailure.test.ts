import assert from "node:assert/strict";
import test from "node:test";
import { NapCatRequestError, projectNapCatDeliveryError } from "@rabiroute/host-api/shared/napcatDeliveryError";
import { diagnoseNapcatSendFailure } from "./sendFailure.js";

const loggedOut = { state: "qr-login-required", needsUserAction: true, webui: { loginInfoReadState: "observed" } };
const cases = [
  { name: "confirmed logout", input: { kind: "transport", transportCode: "ECONNREFUSED" }, observation: loggedOut, code: "NAPCAT_LOGIN_REQUIRED", result: "not_sent", probes: 1 },
  { name: "connection failure with unknown login", input: { kind: "transport", transportCode: "ECONNREFUSED" }, observation: undefined, code: "NAPCAT_CONNECTION_FAILED", result: "not_sent", probes: 1 },
  { name: "unverified logout is not enough", input: { kind: "transport", transportCode: "ECONNREFUSED" }, observation: { ...loggedOut, webui: { loginInfoReadState: "read-failed" } }, code: "NAPCAT_CONNECTION_FAILED", result: "not_sent", probes: 1 },
  { name: "timeout remains uncertain despite logout", input: { kind: "transport", transportCode: "UND_ERR_HEADERS_TIMEOUT" }, observation: loggedOut, code: "NAPCAT_CONNECTION_FAILED", result: "unknown", probes: 0 },
  { name: "QQ permission denial", input: { kind: "rejected", retcode: 100 }, observation: undefined, message: "无权限 private-fixture-secret", code: "QQ_PERMISSION_DENIED", result: "rejected", probes: 0 },
  { name: "retcode alone does not prove permissions", input: { kind: "rejected", retcode: 100 }, observation: undefined, code: "NAPCAT_DELIVERY_FAILED", result: "unknown", probes: 0 },
  { name: "OneBot authentication denial", input: { kind: "http", httpStatus: 403 }, observation: undefined, code: "NAPCAT_AUTHENTICATION_FAILED", result: "not_sent", probes: 0 }
] as const;

for (const scenario of cases) {
  test(scenario.name, async () => {
    let sends = 0, probes = 0;
    const original = new NapCatRequestError("message" in scenario ? scenario.message : "private-fixture-secret", { action: "send_group_msg", ...scenario.input });
    await assert.rejects(diagnoseNapcatSendFailure(async () => { sends++; throw original; }, async () => { probes++; return scenario.observation; }), error => {
      assert.equal(error, original);
      const diagnostic = original.diagnostic as typeof original.diagnostic & { code: string; platformResult: string; message: string; recoveryAction: string };
      assert.equal(diagnostic.code, scenario.code);
      assert.equal(diagnostic.platformResult, scenario.result);
      assert.ok(diagnostic.recoveryAction);
      assert.doesNotMatch(JSON.stringify(diagnostic), /private-fixture-secret/);
      return true;
    });
    assert.equal(sends, 1);
    assert.equal(probes, scenario.probes);
  });
}

test("successful send is unchanged and never probes login", async () => {
  const result = { messageId: "12345" };
  assert.equal(await diagnoseNapcatSendFailure(async () => result, async () => { throw Error("must not observe"); }), result);
});

test("unavailable diagnostics preserve the original connection error", async () => {
  const original = new NapCatRequestError("private-fixture-secret", { action: "send_group_msg", kind: "transport", transportCode: "ECONNREFUSED" });
  await assert.rejects(diagnoseNapcatSendFailure(async () => { throw original; }, async () => { throw Error("observer failed"); }), error => error === original);
  assert.equal((original.diagnostic as { code?: string }).code, "NAPCAT_CONNECTION_FAILED");
});

test("historical diagnostics keep legacy protocol fields and discard arbitrary text", () => {
  const legacy = { action: "send_group_msg", kind: "transport", transportCode: "ECONNREFUSED" };
  assert.deepEqual(projectNapCatDeliveryError(legacy), legacy);
  const projected = projectNapCatDeliveryError({ ...legacy, code: "NAPCAT_LOGIN_REQUIRED", platformResult: "not_sent",
    message: "private-fixture-secret", recoveryAction: "https://private-fixture-secret", token: "private-fixture-secret" });
  assert.equal(projected?.code, "NAPCAT_LOGIN_REQUIRED");
  assert.doesNotMatch(JSON.stringify(projected), /private-fixture-secret/);
  assert.equal(projectNapCatDeliveryError({ ...legacy, action: "http://private-fixture-secret" }), undefined);
});
