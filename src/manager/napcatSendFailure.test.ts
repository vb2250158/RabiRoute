import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import type { MessageEndpointEgressProvider } from "@rabiroute/plugin-sdk";
import { napcatEndpointFixture } from "./napcatEndpointPlugin.fixture.js";
import { handleAgentReply, inspectAgentReplyDelivery, type AgentReplyOptions } from "../outbox.js";

// Synthetic credential used only by the in-memory offline fetch fixture.
const fixtureCredential = "fixture-token";

test("bundled NapCat diagnostics survive the real outbox and receipt projection", { timeout: 60000 }, async t => {
  const f = await napcatEndpointFixture({ observeRoutes: true });
  const originalFetch = globalThis.fetch;
  t.after(async () => { globalThis.fetch = originalFetch; await f.dispose(); });
  const instance = { id: "qq", gatewayPort: 0, enabled: true, httpUrl: "http://onebot.invalid", webuiUrl: "http://webui.invalid/webui", webuiToken: fixtureCredential, accessToken: fixtureCredential, botUserId: "12345" };
  const runtime = { id: "gateway", gatewayPort: 0, enabled: true, configName: "fixture-route", messageAdapters: ["napcat"],
    routeProfiles: [{ id: "profile", enabled: true }], pipeline: { outputAdapter: "qq" as const, outputPipeline: "qq" as const },
    messageAdapterPolicies: { napcat: { outputEnabled: true, supportedOutputs: ["text" as const] } }, napcatInstances: [instance] };
  f.setRoutes([runtime]);
  await f.kernel.switch([f.candidate("diagnostic-fixture")]);
  const provider = f.kernel.current().services.services.get("endpoint.napcat.egress@1")?.value as MessageEndpointEgressProvider;
  assert.ok(provider);
  const options: AgentReplyOptions = { rootDir: f.root, routeRoot: path.join(f.root, "route"), rolesRoot: path.join(f.root, "roles"),
    runtimes: [runtime], endpointEgress: () => provider };
  for (const scenario of ["logged-out", "connection-only", "binding-changed", "permission", "success", "route-disabled"] as const) {
    let platformCalls = 0;
    const calls: string[] = [];
    instance.botUserId = "12345";
    runtime.messageAdapterPolicies.napcat.outputEnabled = scenario !== "route-disabled";
    globalThis.fetch = (async (url: string | URL | Request) => {
      const address = String(url);
      calls.push(address);
      if (address === instance.httpUrl + "/send_group_msg") {
        platformCalls++;
        if (scenario === "permission") return Response.json({ status: "failed", retcode: 100, wording: "无权限 fixture-token private-content" });
        if (scenario === "success") return Response.json({ status: "ok", retcode: 0, data: { message_id: 123 } });
        if (scenario === "binding-changed") instance.botUserId = "67890";
      }
      if (address.startsWith(instance.httpUrl)) throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
      if (scenario === "connection-only") throw Error("private-content");
      if (address.endsWith("/api/auth/login")) return Response.json({ code: 0, data: { Credential: "fixture-credential" } });
      if (address.endsWith("/api/QQLogin/GetQQLoginInfo")) return Response.json({ code: 0, data: {} });
      if (address.endsWith("/api/QQLogin/CheckLoginStatus")) return Response.json({ code: 0, data: { isLogin: false, loginError: "登录态已失效，请重新登录。" } });
      if (address.endsWith("/api/QQLogin/GetQuickLoginListNew")) return Response.json({ code: 0, data: [] });
      return Response.json({ code: 0, data: {} });
    }) as typeof fetch;
    const request = { routeProfileId: "profile", instanceId: "qq", groupId: "45678", explicitTarget: true,
      sendChannel: "napcat", targetType: "group", deliveryId: "diagnostic-" + scenario, text: "fixture message" };
    const result = await handleAgentReply(request, options);
    assert.equal(platformCalls, scenario === "route-disabled" ? 0 : 1);
    assert.equal(result.status, scenario === "route-disabled" ? "blocked" : scenario === "success" ? "sent" : "failed");
    if (scenario === "route-disabled") assert.equal(result.deliveryError?.code, "RABI_ROUTE_PERMISSION_DENIED");
    if (scenario !== "success" && scenario !== "route-disabled") {
      const diagnostic = result.deliveryError as typeof result.deliveryError & { code: string; platformResult: string };
      assert.equal(diagnostic?.code, scenario === "logged-out" ? "NAPCAT_LOGIN_REQUIRED" : scenario === "permission" ? "QQ_PERMISSION_DENIED" : "NAPCAT_CONNECTION_FAILED", JSON.stringify(calls));
      assert.equal(diagnostic.platformResult, scenario === "permission" ? "rejected" : "not_sent");
      assert.doesNotMatch(JSON.stringify(result), /fixture-token|fixture-credential|private-content/);
    }
    const receipt = await inspectAgentReplyDelivery(request, options);
    assert.equal(receipt.state, "completed", JSON.stringify({ scenario, receipt }));
    if (receipt.state === "completed") assert.deepEqual(receipt.result.deliveryError, result.deliveryError);
    assert.equal(platformCalls, scenario === "route-disabled" ? 0 : 1, "receipt reads never resend");
  }
});
