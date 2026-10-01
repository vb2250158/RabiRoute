import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { agentReplyDataDirsForRoute, handleAgentReply, type AgentReplyOptions } from "./outbox.js";
import { recentMessageContextItems } from "./messageContextStore.js";

function fixture(t: test.TestContext, remoteInProfile = false) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-remote-outbox-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const roleDir = path.join(rootDir, "roles", "shared-persona");
  const routeDataDir = path.join(rootDir, "custom-route-audit");
  fs.mkdirSync(roleDir, { recursive: true });
  fs.mkdirSync(routeDataDir, { recursive: true });
  fs.writeFileSync(path.join(roleDir, "persona.md"), "# Local poisoned display name\n", "utf8");
  const runtime: AgentReplyOptions["runtimes"][number] = {
    id: "main",
    name: "Remote route",
    agentRoleId: "shared-persona",
    agentRoleDeviceId: remoteInProfile ? undefined : "remote-pc",
    dataDir: routeDataDir,
    pipeline: { outputAdapter: "agent", outputPipeline: "agent" },
    messageAdapterPolicies: { fennenote: { outputEnabled: true, supportedOutputs: ["text"] } },
    ...(remoteInProfile ? { routeProfiles: [{ id: "remote-profile", name: "Remote profile", agentRoleId: "shared-persona", agentRoleDeviceId: "remote-pc", dataDir: routeDataDir }] } : {})
  };
  const options: AgentReplyOptions = { rootDir, routeRoot: path.join(rootDir, "routes"), rolesRoot: path.join(rootDir, "roles"), runtimes: [runtime] };
  return { rootDir, roleDir, routeDataDir, runtime, options, routeId: remoteInProfile ? "remote-profile" : "main" };
}

function filesIn(directory: string): Record<string, string> {
  return Object.fromEntries(fs.readdirSync(directory).map(name => [name, fs.readFileSync(path.join(directory, name), "utf8")]));
}

test("remote persona ordinary voice reply uses Route source and audit without reading or writing a same-name local persona", async (t) => {
  const { roleDir, routeDataDir, runtime, options, routeId } = fixture(t);
  fs.writeFileSync(path.join(roleDir, "voice-transcripts.jsonl"), `${JSON.stringify({ time: 99, messageId: "voice-1", userId: "poison-local-user", rawMessage: "local wrong owner" })}\n`, "utf8");
  fs.writeFileSync(path.join(routeDataDir, "voice-transcripts.jsonl"), `${JSON.stringify({ time: 1, messageId: "voice-1", userId: "route-user", rawMessage: "route source" })}\n`, "utf8");
  const before = filesIn(roleDir);
  let forwarded: Record<string, unknown> | undefined;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      forwarded = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, id: "fixture-voice-reply" }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  options.fenneNotePlaybackUrl = `http://127.0.0.1:${address.port}/playback`;
  const result = await handleAgentReply({
    deliveryId: "remote-voice-delivery",
    text: "Remote persona reply through the original local voice adapter.",
    replyContext: { runtimeRouteId: "main", routeProfileId: routeId, messageId: "voice-1", targetType: "voice_transcript", adapterType: "fennenote", outputAdapter: "fennenote", outputPipeline: "fennenote", agentRoleDeviceId: "forged-device" }
  }, options);
  assert.equal(result.status, "sent");
  assert.equal(result.userId, "route-user");
  assert.equal(forwarded?.agentRoleName, "Remote route");
  assert.equal(forwarded?.agentRoleId, "shared-persona");
  assert.deepEqual(agentReplyDataDirsForRoute(options, { runtime }), [routeDataDir, path.join(options.routeRoot, "main")]);
  const context = recentMessageContextItems([routeDataDir], { limit: 10, maxChars: 10000 });
  assert.equal(context.length, 1);
  assert.match(context[0]!.text, /Remote persona reply/);
  assert.ok(fs.existsSync(path.join(routeDataDir, "outbox-adapter.log.jsonl")));
  const audit = fs.readFileSync(path.join(routeDataDir, "outbox-adapter.log.jsonl"), "utf8");
  assert.match(audit, /"agentRoleDeviceId":"remote-pc"/);
  assert.deepEqual(filesIn(roleDir), before);
});

test("remote persona panel, feedback, and plan attachment cannot invoke local owner write ports", async (t) => {
  for (const remoteInProfile of [false, true]) {
    const { roleDir, routeDataDir, options, routeId } = fixture(t, remoteInProfile);
    const before = filesIn(roleDir);
    let localOwnerCalls = 0;
    options.appendRolePanelTimeline = async () => { localOwnerCalls += 1; throw new Error("must not call local timeline"); };
    options.submitPlanFeedback = async () => { localOwnerCalls += 1; throw new Error("must not call local feedback"); };
    options.withManagedPlanAttachment = async () => { localOwnerCalls += 1; throw new Error("must not resolve local plan"); };
    const context = { runtimeRouteId: "main", routeProfileId: routeId, roleId: "shared-persona", agentRoleDeviceId: "", messageId: "source-1" };
    const panel = await handleAgentReply({ deliveryId: "panel-1", text: "panel reply", replyContext: { ...context, targetType: "role_panel", adapterType: "rolePanel" } }, options);
    const feedback = await handleAgentReply({ deliveryId: "feedback-1", text: "plan feedback", replyContext: { ...context, targetType: "plan_feedback", adapterType: "rolePanel", planId: "plan-1", planFeedbackId: "feedback-source" } }, options);
    const attachment = await handleAgentReply({ deliveryId: "attachment-1", payload: { type: "file", planAttachment: { roleId: "shared-persona", planId: "plan-1", attachmentId: "attachment-1" } }, replyContext: context }, options);
    for (const result of [panel, feedback, attachment]) {
      assert.equal(result.status, "blocked");
      assert.match(result.reason ?? "", /REMOTE_PERSONA_OWNER_REQUIRED/);
    }
    assert.equal(localOwnerCalls, 0);
    assert.deepEqual(filesIn(roleDir), before);
    assert.ok(fs.existsSync(path.join(routeDataDir, "outbox-adapter.log.jsonl")));
  }
});

test("remote persona source lookup never falls back to same-name local history or bare remote role alias", async (t) => {
  const { roleDir, options } = fixture(t);
  fs.writeFileSync(path.join(roleDir, "group-messages.jsonl"), `${JSON.stringify({ time: 1, messageId: "only-local-role-source", groupId: "wrong-group", rawMessage: "local role source" })}\n`, "utf8");
  options.runtimes.push({ id: "other", pipeline: { outputAdapter: "agent", outputPipeline: "agent" } });
  const noSource = await handleAgentReply({ text: "reply", messageId: "only-local-role-source" }, options);
  assert.equal(noSource.status, "blocked");
  assert.match(noSource.reason ?? "", /Route source context is required/);
  const noRoleAlias = await handleAgentReply({ text: "reply", routeProfileId: "shared-persona" }, options);
  assert.equal(noRoleAlias.status, "blocked");
  assert.match(noRoleAlias.reason ?? "", /Route source context is required/);
});
