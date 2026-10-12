import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  agentReplyCurrentQqBinding, agentReplyHistorySource, handleAgentReply, projectAgentReplyHistoryResult,
  type AgentReplyOptions, type AgentReplyRequest
} from "./outbox.js";

function fixture(rootDir: string): AgentReplyOptions {
  return {
    rootDir, routeRoot: path.join(rootDir, "route"), rolesRoot: path.join(rootDir, "roles"),
    runtimes: [{ id: "gateway", configName: "route-config", enabled: true,
      routeProfiles: [{ id: "profile", enabled: true }],
      pipeline: { outputAdapter: "qq", outputPipeline: "qq" },
      messageAdapterPolicies: { napcat: { outputEnabled: true, supportedOutputs: ["file"], allowedFileRoots: [rootDir] } },
      napcatInstances: [{ id: "qq", httpUrl: "http://mock.invalid", accessToken: "fake-fixture-secret", enabled: true }]
    }]
  };
}
const bindingRequest = { routeProfileId: "profile", instanceId: "qq", groupId: "20002" };

test("QQ binding helper is a stable owner-only unique configuration snapshot", () => {
  const options = fixture(os.tmpdir());
  const first = agentReplyCurrentQqBinding(bindingRequest, options)!;
  assert.ok(first);
  assert.equal(first.routeId, "profile");
  assert.match(first.bindingRevision, /^sha256:[a-f0-9]{64}$/);
  assert.equal(agentReplyCurrentQqBinding({ ...bindingRequest, text: "changed message", botUserId: "9999" }, options)?.bindingRevision, first.bindingRevision);
  assert.equal(agentReplyCurrentQqBinding({ ...bindingRequest, routeProfileId: "route-config" }, options)?.bindingRevision, first.bindingRevision);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.endpoint));
  options.runtimes[0].name = "renamed display";
  options.runtimes[0].routeVariables = { unrelated: "runtime-generation" };
  assert.equal(agentReplyCurrentQqBinding(bindingRequest, options)?.bindingRevision, first.bindingRevision);
  const instance = options.runtimes[0].napcatInstances![0];
  instance.accessToken = "fake-rotated-secret";
  assert.notEqual(agentReplyCurrentQqBinding(bindingRequest, options)?.bindingRevision, first.bindingRevision);
  assert.equal(first.endpoint.accessToken, "fake-fixture-secret");
  instance.httpUrl = "http://replacement.invalid";
  assert.notEqual(agentReplyCurrentQqBinding(bindingRequest, options)?.bindingRevision, first.bindingRevision);
  assert.equal(agentReplyCurrentQqBinding({ ...bindingRequest, groupId: "20003" }, options)?.bindingRevision === first.bindingRevision, false);
  assert.equal(agentReplyCurrentQqBinding({ ...bindingRequest, instanceId: "other" }, options), undefined);
  assert.equal(agentReplyCurrentQqBinding({ ...bindingRequest, routeProfileId: "missing" }, options), undefined);
  instance.enabled = false;
  assert.equal(agentReplyCurrentQqBinding(bindingRequest, options), undefined);
  instance.enabled = true;
  options.runtimes[0].napcatInstances!.push({ id: "second", httpUrl: "http://other.invalid", accessToken: "", enabled: true });
  assert.equal(agentReplyCurrentQqBinding(bindingRequest, options), undefined);
  options.runtimes[0].enabled = false;
  assert.equal(agentReplyCurrentQqBinding(bindingRequest, options), undefined);
});

for (const scenario of ["stable", "managed_stable", "managed_upload_failed", "account_changed", "token_rotated", "endpoint_changed", "instance_changed", "route_disabled", "profile_disabled", "login_failed", "post_login_failed", "before_config_changed", "invalid_account", "ambiguous", "upload_failed"] as const) {
  test(`QQ upload owner evidence: ${scenario}`, async (t) => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-qq-owner-"));
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; fs.rmSync(rootDir, { recursive: true, force: true }); });
    const options = fixture(rootDir);
    const filePath = path.join(rootDir, "fixture.bin");
    fs.writeFileSync(filePath, "mock bytes");
    const request: AgentReplyRequest = {
      ...bindingRequest, explicitTarget: true, sendChannel: "napcat", targetType: "group", deliveryId: `fixture-${scenario}`,
      payloadType: "file", filePath, botUserId: "7777",
      ...({ selfId: "7777", bindingRevision: "client-forged" } as Record<string, unknown>)
    };
    const managed = scenario.startsWith("managed_");
    const uploadFailed = scenario === "upload_failed" || scenario === "managed_upload_failed";
    if (managed) {
      delete request.filePath;
      request.adapterType = "napcat";
      request.payload = { type: "file", fileId: "00000000-0000-4000-8000-000000000001", fileSha256: "a".repeat(64) };
      options.withManagedGroupFile = async (fileId, sha256, send) => {
        assert.equal(fileId, "00000000-0000-4000-8000-000000000001");
        assert.equal(sha256, "a".repeat(64));
        return await send({ path: filePath, fileName: "fixture.bin" });
      };
    }
    const expectedRevision = agentReplyCurrentQqBinding(request, options)!.bindingRevision;
    const instance = options.runtimes[0].napcatInstances![0];
    if (scenario === "ambiguous") options.runtimes[0].napcatInstances!.push({ id: "second", httpUrl: "http://second.invalid", accessToken: "" });
    let loginCalls = 0;
    let uploadCalls = 0;
    const calls: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/get_login_info")) {
        loginCalls++;
        assert.ok(init?.signal);
        if (scenario === "login_failed" || scenario === "post_login_failed" && loginCalls === 2) throw new Error("private upstream fake-fixture-secret");
        if (scenario === "before_config_changed" && loginCalls === 1) instance.accessToken = "fake-rotated-secret";
        const user_id = scenario === "invalid_account" ? "invalid" : scenario === "account_changed" && loginCalls === 2 ? "9001" : "9000";
        return new Response(JSON.stringify({ status: "ok", retcode: 0, data: { user_id } }));
      }
      assert.equal(url, "http://mock.invalid/upload_group_file");
      uploadCalls++;
      if (uploadFailed) return new Response(JSON.stringify({ status: "failed", retcode: 1 }));
      if (scenario === "token_rotated") instance.accessToken = "fake-rotated-secret";
      if (scenario === "endpoint_changed") instance.httpUrl = "http://replacement.invalid";
      if (scenario === "instance_changed") instance.id = "replacement";
      if (scenario === "route_disabled") options.runtimes[0].enabled = false;
      if (scenario === "profile_disabled") options.runtimes[0].routeProfiles![0].enabled = false;
      if (scenario === "before_config_changed") assert.equal((init?.headers as Record<string, string>).authorization, "Bearer fake-fixture-secret");
      return new Response(JSON.stringify({ status: "ok", retcode: 0, data: { file_id: "platform-file", file_name: "fixture.bin" } }));
    }) as typeof fetch;
    const logPath = agentReplyHistorySource(request, options).logPath;
    const result = await handleAgentReply(request, options);
    assert.equal(uploadCalls, 1);
    assert.equal(result.status, uploadFailed ? "failed" : "sent");
    assert.equal("selfId" in result, false);
    assert.equal("bindingRevision" in result, false);
    const logText = fs.readFileSync(logPath, "utf8");
    const uploaded = logText.trim().split("\n").map(line => JSON.parse(line)).filter(row => row.event === "group_file_uploaded");
    assert.equal(uploaded.length, uploadFailed ? 0 : 1);
    if (uploaded.length) {
      const data = uploaded[0].data;
      assert.equal(data.instanceId, "qq");
      assert.equal(data.sentFileId, "platform-file");
      if (scenario === "stable" || scenario === "managed_stable") {
        assert.equal(loginCalls, 2);
        assert.equal(data.selfId, "9000");
        assert.equal(data.bindingRevision, expectedRevision);
        assert.equal(data.qqOwnerEvidence, undefined);
      } else {
        assert.equal(data.selfId, undefined);
        assert.equal(data.bindingRevision, undefined);
        assert.equal(data.qqOwnerEvidence, "unknown");
      }
      const publicResult = projectAgentReplyHistoryResult(data);
      assert.equal("selfId" in publicResult, false);
      assert.equal("bindingRevision" in publicResult, false);
    }
    assert.equal(logText.includes("fake-fixture-secret"), false);
    assert.equal(logText.includes("http://mock.invalid"), false);
    assert.equal(logText.includes("fake-rotated-secret"), false);
    assert.ok(calls.every(url => url.endsWith("/get_login_info") || url.endsWith("/upload_group_file")));
  });
}
