import { withTestEndpointEgress } from "../endpointEgress.fixture.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { nativeHttpTestFetch } from "./nativeHttpTestClient.js";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { AgentCompletionDeliveryService, completionProjectIdentity, completionTaskContextFromPlans, deliverCompletionToEndpoint, completionLocalFiles, completionMessagePayloads, planCompletionDeliveryRules, splitCompletionMessage, type CompletionRuleOwner } from "./agentCompletionDelivery.js";
import { CodexHookContextService, type CodexHookContextRequest } from "./codexHookContext.js";

const owner: CompletionRuleOwner = { roleId: "test", rule: { id: "rule", enabled: true,
  event: "task_completed", conditions: [{ type: "project", path: "/project" }],
  destination: { channel: "napcat", gatewayId: "route", params: { target: "group", instanceId: "qq", targetId: "12345" } } } };
const event = { eventName: "Stop" as const, sessionId: "agent-1", turnId: "turn-1", cwd: "/project", lastAssistantMessage: "Done" };

test("heartbeat completion honors silence and sends only notification text without mutating hook evidence", async () => {
  const sent: string[] = [];
  let discoveries = 0;
  const service = new AgentCompletionDeliveryService({
    rules: () => { discoveries++; return [owner]; }, projectIdentity: async value => value,
    deliver: async (_owner, request) => { sent.push(request.lastAssistantMessage!); }
  });
  const envelope = (decision: string, message: string) =>
    `<heartbeat>\n <automation_id>review-check</automation_id>\n <decision>${decision}</decision>\n <message>${message}</message>\n</heartbeat>`;
  const silent = { ...event, lastAssistantMessage: envelope("DONT_NOTIFY", "No new results") };
  assert.deepEqual(await service.handle(silent), []);
  assert.equal(discoveries, 0, "silent heartbeats must not resolve destinations or send");
  const notify = { ...event, lastAssistantMessage: envelope("NOTIFY", "Ready\nTwo checks passed.") };
  await service.handle(notify);
  assert.deepEqual(sent, ["Ready\nTwo checks passed."]);
  assert.equal(notify.lastAssistantMessage, envelope("NOTIFY", "Ready\nTwo checks passed."));
  await service.handle({ ...event, lastAssistantMessage: envelope("NOTIFY", "  ") });
  assert.equal(sent.length, 1, "empty notifications must not produce heading-only messages");
  const ordinary = ["DONT_NOTIFY is a control value", "<result>Done</result>",
    "```xml\n" + silent.lastAssistantMessage + "\n```", "Example:\n" + silent.lastAssistantMessage,
    envelope("UNKNOWN", "Keep evidence"), "<heartbeat>unfinished",
    silent.lastAssistantMessage + "\n" + notify.lastAssistantMessage];
  for (const lastAssistantMessage of ordinary) await service.handle({ ...event, lastAssistantMessage });
  assert.deepEqual(sent.slice(1), ordinary);
});

test("completion rule discovery receives the same recovered persona scope as Stop", async () => {
  const scopes: Array<readonly string[] | undefined> = [];
  const service = new AgentCompletionDeliveryService({ rules: (_request, roleIds) => { scopes.push(roleIds); return []; },
    deliver: async () => { assert.fail("No matching rules"); } });
  await service.handle(event, ["ReadyRole"]);
  await service.handle({ ...event, turnId: "unbound-turn" });
  assert.deepEqual(scopes, [["ReadyRole"], undefined]);
});

test("exclude-heartbeat condition skips heartbeat results per rule without silencing ordinary replies", async () => {
  const sent: string[] = [];
  const rules = [{ ...owner, rule: { ...owner.rule, conditions: [{ type: "exclude_heartbeat" }] } }];
  const service = new AgentCompletionDeliveryService({ rules: () => rules,
    taskContext: () => ({ plans: [] }), deliver: async (selected, request) => { sent.push(`${selected.rule.id}:${request.lastAssistantMessage}`); } });
  const envelope = (decision: string) => `<heartbeat><automation_id>review-check</automation_id><decision>${decision}</decision><message>Review result</message></heartbeat>`;
  for (const decision of ["DONT_NOTIFY", "NOTIFY"]) {
    assert.deepEqual(await service.handle({ ...event, lastAssistantMessage: envelope(decision) }), []);
  }
  assert.deepEqual(sent, []);
  await service.handle(event);
  await service.handle({ ...event, lastAssistantMessage: "Example:\n" + envelope("NOTIFY") });
  await service.handle({ ...event, lastAssistantMessage: "```xml\n" + envelope("NOTIFY") + "\n```" });
  assert.equal(sent.length, 3, "a normal reply in the same task and quoted examples still match");
  rules.push({ ...owner, rule: { ...owner.rule, id: "unfiltered", conditions: [] } });
  await service.handle({ ...event, lastAssistantMessage: envelope("NOTIFY") });
  assert.equal(sent.at(-1), "unfiltered:Review result", "the condition applies only to its own rule, before destination deduplication");
});

test("optional plan channels merge with persona rules and deduplicate the same destination", async () => {
  const plans = [{ id: "plan", taskBinding: { agentType: "codex" as const, sessionId: "agent-1", workspace: "/project" }, messageChannels: [owner.rule.destination] }];
  assert.deepEqual(planCompletionDeliveryRules("test", plans, "other"), []);
  assert.deepEqual(planCompletionDeliveryRules("test", [{ ...plans[0], messageChannels: undefined }], "agent-1"), []);
  let sent = 0;
  const service = new AgentCompletionDeliveryService({ rules: request => [owner, ...planCompletionDeliveryRules("test", plans, request.sessionId)],
    projectIdentity: async value => value, taskContext: () => ({ plans: [{ id: "plan", title: "Plan" }] }),
    deliver: async () => { sent += 1; } });
  await service.handle(event);
  assert.equal(sent, 1);
  await service.handle({ ...event, sessionId: "other" });
  assert.equal(sent, 2, "unbound sessions still use persona event rules");
});

test("session allow and deny lists match exact IDs, combine with project and plan, and deny wins", async () => {
  const sent: string[] = [];
  const service = new AgentCompletionDeliveryService({
    rules: () => [{ ...owner, rule: { ...owner.rule, conditions: [...owner.rule.conditions,
      { type: "bound_plan" },
      { type: "include_sessions", sessions: [{ id: "agent-1", name: "Old title" }, { id: "agent-2", name: "Same title" }, { id: "unbound", name: "Other" }] },
      { type: "exclude_sessions", sessions: [{ id: "agent-2", name: "Changed title" }] }
    ] } }], projectIdentity: async value => value,
    taskContext: (_, request) => ({ taskName: "Renamed", plans: request.sessionId === "unbound" ? [] : [{ id: "p", title: "Plan" }] }),
    deliver: async (_, request) => { sent.push(request.sessionId); }
  });
  for (const sessionId of ["agent-1", "agent-2", "agent-10", "unbound"]) await service.handle({ ...event, sessionId });
  await service.handle({ ...event, cwd: "/other" });
  assert.deepEqual(sent, ["agent-1"]);
  const denyOnly = new AgentCompletionDeliveryService({ rules: () => [{ ...owner, rule: { ...owner.rule,
    conditions: [{ type: "exclude_sessions", sessions: [{ id: "agent-1", name: "Name" }] }] } }],
    deliver: async (_, request) => { sent.push(request.sessionId); } });
  await denyOnly.handle(event);
  await denyOnly.handle({ ...event, sessionId: "another" });
  assert.deepEqual(sent, ["agent-1", "another"]);
});

test("plan requirement skips unbound tasks and uses the current task title with actual bindings", async () => {
  const plans = [
    { id: "plan-1", title: "修复登录窗口", taskBinding: { agentType: "codex" as const, sessionId: "agent-1", sessionTitle: "旧任务名" } },
    { id: "plan-2", title: "其它任务的计划", taskBinding: { agentType: "codex" as const, sessionId: "other" } },
    { id: "plan-3", title: "DSH 的计划", taskBinding: { agentType: "dsh" as const, sessionId: "agent-1" } }
  ];
  const context = completionTaskContextFromPlans("agent-1", plans, "当前任务名");
  assert.equal(context.taskName, "当前任务名");
  assert.deepEqual(context.plans, [{ id: "plan-1", title: "修复登录窗口" }, { id: "plan-3", title: "DSH 的计划" }], "every adapter bound to the session participates");
  assert.equal(completionTaskContextFromPlans("agent-1", plans).taskName, undefined, "a stored plan label must not impersonate the current task title");
  const calls: string[] = [];
  const service = new AgentCompletionDeliveryService({ rules: () => [{ ...owner, rule: { ...owner.rule, conditions: [...owner.rule.conditions, { type: "bound_plan" }] } }],
    projectIdentity: async value => value, taskContext: (_, hook) => completionTaskContextFromPlans(hook.sessionId, plans),
    deliver: async (_, hook) => { calls.push(hook.sessionId); } });
  await service.handle({ ...event, sessionId: "unbound" });
  await service.handle(event);
  assert.deepEqual(calls, ["agent-1"]);
  const optional = new AgentCompletionDeliveryService({ rules: () => [owner], projectIdentity: async value => value,
    taskContext: () => ({ plans: [] }), deliver: async (_, hook) => { calls.push(hook.sessionId); } });
  await optional.handle({ ...event, sessionId: "unbound" });
  assert.deepEqual(calls, ["agent-1", "unbound"]);
});

test("completion rules cover every session and every managed adapter, isolate other projects, and coalesce repeated targets", async () => {
  const sends: string[] = [];
  const service = new AgentCompletionDeliveryService({ rules: () => [owner, { ...owner, rule: { ...owner.rule, id: "duplicate" } }],
    projectIdentity: async value => value, deliver: async (_, __, id) => { sends.push(id); } });
  assert.equal((await service.handle(event)).length, 1);
  await service.handle({ ...event, sessionId: "agent-2" });
  await service.handle({ ...event, cwd: "/project-other" });
  assert.equal((await service.handle({ ...event, agentType: "dsh" })).length, 1, "a DSH session drives the same completion deliveries as Codex");
  await service.handle({ ...event, turnId: "" });
  await service.handle({ ...event, lastAssistantMessage: " " });
  assert.equal(sends.length, 3);
  assert.notEqual(sends[0], sends[1]);
});

test("an unmanaged adapter never triggers completion deliveries", async () => {
  const sends: string[] = [];
  const service = new AgentCompletionDeliveryService({ rules: () => [owner],
    projectIdentity: async value => value, deliver: async (_, __, id) => { sends.push(id); } });
  assert.deepEqual(await service.handle({ ...event, agentType: "astrbot" }), []);
  assert.deepEqual(await service.handle({ ...event, agentType: "not-an-adapter" }), []);
  assert.equal(sends.length, 0);
});

test("concurrent Stop callbacks share one delivery and retain a stable identity after restart", async () => {
  const sends: string[] = [];
  const options = { rules: () => [owner], projectIdentity: async (value: string) => value,
    deliver: async (_: unknown, __: unknown, id: string) => { sends.push(id); await Promise.resolve(); } };
  const service = new AgentCompletionDeliveryService(options);
  await Promise.all([service.handle(event), service.handle(event)]);
  assert.equal(sends.length, 1);
  await new AgentCompletionDeliveryService(options).handle(event);
  assert.equal(sends[1], sends[0]);
});

test("a failed target reports failure without suppressing another target", async () => {
  const service = new AgentCompletionDeliveryService({ rules: () => [owner, { ...owner, rule: { ...owner.rule, id: "second", destination: { ...owner.rule.destination, params: { ...owner.rule.destination.params, targetId: "67890" } } } }],
    projectIdentity: async value => value, deliver: async ({ rule }) => { if (rule.id === "rule") throw new Error("offline"); } });
  assert.deepEqual((await service.handle(event)).map(result => result.status), ["failed", "sent"]);
});

test("Git worktrees share the project identity while another repository does not", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-completion-git-"));
  const repo = path.join(root, "repo"); const worktree = path.join(root, "worktree"); const other = path.join(root, "other");
  const git = (args: string[]) => execFileSync("git", args, { windowsHide: true, stdio: "pipe" });
  try {
    git(["init", repo]); git(["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "fixture"]);
    git(["-C", repo, "worktree", "add", "--detach", worktree]); git(["init", other]);
    assert.equal(await completionProjectIdentity(repo), await completionProjectIdentity(worktree));
    assert.notEqual(await completionProjectIdentity(repo), await completionProjectIdentity(other));
    fs.mkdirSync(path.join(repo, "app")); fs.mkdirSync(path.join(worktree, "app"));
    assert.equal(await completionProjectIdentity(path.join(repo, "app")), await completionProjectIdentity(path.join(worktree, "app")));
    assert.notEqual(await completionProjectIdentity(repo), await completionProjectIdentity(path.join(repo, "app")), "separate Codex projects in a monorepo remain isolated");
    await assert.rejects(completionProjectIdentity("relative/path"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Stop completion delivery works without binding individual sessions and obeys startup recovery", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-completion-hook-"));
  const calls: string[] = [];
  const options = { rolesRoot: () => root, storePath: path.join(root, "sessions.json"), hookEnabled: () => false,
    deliverAgentCompletion: async (request: CodexHookContextRequest) => { calls.push(request.sessionId); return []; } };
  try {
    await new CodexHookContextService(options).handleHook(event);
    assert.deepEqual(calls, ["agent-1"]);
    await new CodexHookContextService({ ...options,
      recordAgentRequestStop: () => ({ status: "failed", reason: "completion_check_failed" })
    }).handleHook(event);
    assert.equal(calls.length, 1, "a failed completion check must not announce completion");
    await assert.rejects(new CodexHookContextService({ ...options, planStorageReady: () => false }).handleHook(event));
    assert.equal(calls.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("completion reaches the selected group through Outbox and repeated events reuse the persistent receipt", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-completion-send-"));
  const messages: Record<string, unknown>[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      messages.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 45678 } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const options = { rootDir, routeRoot: path.join(rootDir, "data/route"), rolesRoot: path.join(rootDir, "data/roles"),
    runtimes: [{ id: "route", enabled: true, napcatInstances: [{ id: "qq", httpUrl: `http://127.0.0.1:${address.port}`, accessToken: "", enabled: true }] }] };
  try {
    const create = () => new AgentCompletionDeliveryService({ rules: () => [owner], projectIdentity: async value => value,
      taskContext: () => ({ taskName: "修复登录失败", plans: [{ id: "plan-1", title: "登录窗口修复计划" }] }),
      deliver: ({ rule }, hook, id, context) => deliverCompletionToEndpoint(rule, hook, id, "route", withTestEndpointEgress(options), context) });
    assert.equal((await create().handle(event))[0].status, "sent");
    assert.equal((await create().handle(event))[0].status, "sent");
    assert.equal(messages.length, 1);
    assert.equal(messages[0].group_id, 12345);
    assert.match(String(messages[0].message), /Done/);
    assert.match(String(messages[0].message), /任务：修复登录失败/);
    assert.doesNotMatch(String(messages[0].message), /计划：|登录窗口修复计划/);
    assert.doesNotMatch(String(messages[0].message), /项目：|\/project|agent-1/);
    assert.doesNotMatch(String(messages[0].message), /CQ:reply/);
    const changed = await create().handle({ ...event, lastAssistantMessage: "Changed final" });
    assert.equal(changed[0].status, "failed", "a changed payload cannot silently reuse the old identity");
    assert.equal(messages.length, 1);
    const longFinal = "文档已写好：\n\n[说明](https://example.com/mechanism)\n" + "完整机制与验证😀\n".repeat(1000);
    const longEvent = { ...event, turnId: "long-final", lastAssistantMessage: longFinal };
    assert.equal((await create().handle(longEvent))[0].status, "sent");
    const count = messages.length;
    assert.ok(count > 2);
    const delivered = messages.slice(1).map(message => String(message.message)).join("");
    assert.ok(delivered.endsWith(longFinal.trim()));
    assert.match(delivered, /任务：修复登录失败/);
    assert.doesNotMatch(delivered, /下一步：/);
    assert.equal((await create().handle(longEvent))[0].status, "sent");
    assert.equal(messages.length, count, "replaying a multipart final reuses every part receipt");
    const heartbeat = (decision: string) => ({ ...event, turnId: `heartbeat-${decision}`,
      lastAssistantMessage: `<heartbeat><automation_id>review-check</automation_id><decision>${decision}</decision><message>Checks complete.</message></heartbeat>` });
    assert.deepEqual(await create().handle(heartbeat("DONT_NOTIFY")), []);
    assert.equal(messages.length, count, "silent control replies never reach the HTTP endpoint");
    assert.equal((await create().handle(heartbeat("NOTIFY")))[0].status, "sent");
    assert.equal(messages.length, count + 1);
    assert.match(String(messages[count].message), /Checks complete\./);
    assert.doesNotMatch(String(messages[count].message), /heartbeat|automation_id|decision|<message>/);
    assert.equal((await create().handle(heartbeat("NOTIFY")))[0].status, "sent");
    assert.equal(messages.length, count + 1, "heartbeat replay reuses the receipt for the normalized body");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("endpoint selection delivers to private QQ or speech with independent parameters and receipts", async (t) => {
  t.mock.method(globalThis, "fetch", nativeHttpTestFetch);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-hook-endpoints-"));
  const received: Array<{ url?: string; body: Record<string, unknown> }> = [];
  let includePlaybackJob = true;
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      received.push({ url: request.url, body: JSON.parse(body) });
      response.writeHead(200, { "content-type": "application/json", ...(includePlaybackJob ? { "x-rabispeech-playback-job": "speech-job-1" } : {}) });
      response.end(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 56789 } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const options = { rootDir, routeRoot: path.join(rootDir, "data/route"), rolesRoot: path.join(rootDir, "data/roles"), speechServiceUrl: url,
    runtimes: [{ id: "route", enabled: true, agentRoleId: "announcer",
      routeVariables: { speechTtsModel: "local-tts/test", speechSpeed: "1.25", speechLanguage: "zh", speechAutoPlay: "true" },
      napcatInstances: [{ id: "qq", httpUrl: url, accessToken: "", enabled: true }],
      messageAdapterPolicies: { speech: { outputEnabled: true, supportedOutputs: ["text" as const] } } }] };
  const privateRule = { ...owner.rule, destination: { channel: "napcat", gatewayId: "route",
    params: { target: "private", targetId: "67890", instanceId: "qq" } } };
  const speechRule = { ...owner.rule, id: "speech", conditions: [], destination: { channel: "speech", gatewayId: "route", params: {} } };
  const create = () => new AgentCompletionDeliveryService({ rules: () => [{ ...owner, rule: privateRule }, { ...owner, rule: speechRule }],
    projectIdentity: async value => value,
    deliver: ({ rule }, hook, id, context) => deliverCompletionToEndpoint(rule, hook, id, "route", withTestEndpointEgress(options), context) });
  try {
    const first = await create().handle(event);
    assert.deepEqual(first.map(result => result.status), ["sent", "sent"], JSON.stringify({ port: address.port, results: first }));
    const repeated = await create().handle(event);
    assert.deepEqual(repeated.map(result => result.status), ["sent", "sent"], JSON.stringify({ port: address.port, results: repeated }));
    assert.equal(received.length, 2);
    assert.equal(received[0].url, "/send_private_msg");
    assert.equal(received[0].body.user_id, 67890);
    assert.equal(received[0].body.group_id, undefined);
    assert.equal(received[1].url, "/v1/audio/speech");
    assert.equal(received[1].body.user_id, undefined);
    assert.equal(received[1].body.voice, "announcer");
    assert.equal(received[1].body.model, "local-tts/test");
    assert.equal(received[1].body.speed, 1.25);
    assert.equal(received[1].body.play, true);
    includePlaybackJob = false;
    const synthesisOnly = new AgentCompletionDeliveryService({ rules: () => [{ ...owner, rule: speechRule }],
      deliver: ({ rule }, hook, id, context) => deliverCompletionToEndpoint(rule, hook, id, "route", withTestEndpointEgress(options), context) });
    assert.equal((await synthesisOnly.handle({ ...event, turnId: "synthesis-only", cwd: undefined }))[0].status, "sent");
    assert.equal((await synthesisOnly.handle({ ...event, turnId: "synthesis-only", cwd: undefined }))[0].status, "sent");
    assert.equal(received.length, 3, "synthesis without a playback job still has an authoritative receipt");
    options.runtimes[0].routeVariables.speechAutoPlay = "false";
    assert.equal((await synthesisOnly.handle({ ...event, turnId: "playback-disabled" }))[0].status, "sent");
    assert.equal(received[3].body.play, false, "TTS Hook respects the route's disabled playback setting");
    assert.deepEqual(await create().handle({ ...event, eventName: "PreToolUse" }), []);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});


test("completion text chunks preserve multiline replies, links and Unicode without plan prose", () => {
  const text = "文档已写好：\n\n[说明](https://example.com/mechanism)\n" + "机制与验证状态😀\n".repeat(1500);
  const parts = splitCompletionMessage(text);
  assert.ok(parts.length > 1);
  assert.equal(parts.join(""), text);
  assert.ok(parts.every(part => part.length <= 3000 && !/[\ud800-\udbff]$/.test(part)));
  assert.deepEqual(splitCompletionMessage("abcd😀ef", 5), ["abcd", "😀ef"]);
});


test("completion local links decode paths, strip source anchors, deduplicate and ignore web links and code", () => {
  const base = path.join(os.tmpdir(), "结果 (final).md");
  const url = new URL(`file:///${base.replaceAll("\\", "/").replace(/^\//, "")}`).href;
  assert.deepEqual(completionLocalFiles(`[报告](<${base}:12>) [重复](${url}) [web](https://example.com/a.md)\n\n` +
    "```md\n[example](/private/secret.md)\n```"), [path.normalize(base)]);
});

test("QQ completion attachments use group/private uploads, isolate missing files, preserve receipts and honor opt out", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-completion-files-"));
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", chunk => { body += chunk; }); req.on("end", () => {
      calls.push({ url: req.url!, body: JSON.parse(body) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", retcode: 0, data: req.url!.includes("upload") ? { file_id: "uploaded-" + calls.length } : { message_id: calls.length } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const options = { rootDir, routeRoot: path.join(rootDir, "data/route"), rolesRoot: path.join(rootDir, "data/roles"),
    runtimes: [{ id: "route", enabled: true, napcatInstances: [{ id: "qq", httpUrl: `http://127.0.0.1:${address.port}`, accessToken: "", enabled: true }] }] };
  const a = path.join(rootDir, "report.html"), b = path.join(rootDir, "详情 (final).md"), missing = path.join(rootDir, "missing.md");
  fs.writeFileSync(a, "report"); fs.writeFileSync(b, "details");
  const lastAssistantMessage = `[报告](<${a}>) [丢失](<${missing}>) [详情](<${b}>) [重复](<${a}>)`;
  try {
    for (const target of ["group", "private"]) {
      const rule = { ...owner.rule, destination: { ...owner.rule.destination, params: { ...owner.rule.destination.params, target } } };
      const hook = { ...event, lastAssistantMessage };
      const id = "attachment-" + target;
      await assert.rejects(deliverCompletionToEndpoint(rule, hook, id, "route", withTestEndpointEgress(options)), /部分附件未确认/);
      const uploads = calls.filter(call => call.url === `/upload_${target}_file`);
      assert.deepEqual(uploads.map(call => call.body.file), [a, b]);
      const count = calls.length;
      await assert.rejects(deliverCompletionToEndpoint(rule, hook, id, "route", withTestEndpointEgress(options)), /部分附件未确认/);
      assert.equal(calls.length, count, "confirmed text and uploads must not repeat after partial failure");
      const disabled = { ...rule, destination: { ...rule.destination, params: { ...rule.destination.params, includeFiles: "false" } } };
      await deliverCompletionToEndpoint(disabled, hook, id + "-disabled", "route", withTestEndpointEgress(options));
      assert.equal(calls.length, count + 1, "opt out sends only text");
    }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(rootDir, { recursive: true, force: true }); }
});


test("tables render independently of diagrams, preserve source order and honor explicit opt out", () => {
  const table = "| 固定镜头下的路径 | 实测 |\n|---|---:|\n| LateUpdate | 1.061ms/帧 |\n| StaticShadow | **2793次/帧，方法体0.241ms/帧** |\n";
  const body = "前文\n\n" + table + "\n后文";
  const [payload] = completionMessagePayloads(body, false);
  const segments = payload.segments as Array<{type:string;text:string}>;
  assert.deepEqual(segments.map(s => s.type), ["text", "markdown", "text"]);
  assert.equal(segments.map(s => s.text).join(""), body);
  assert.deepEqual(completionMessagePayloads(body, true, undefined, [], false), [{type:"text",text:body}]);
  const fenced = "```md\n" + table + "```";
  assert.deepEqual(completionMessagePayloads(fenced, true), [{type:"text",text:fenced}]);
  const prose = "普通 | 分隔符\n不构成表格";
  assert.deepEqual(completionMessagePayloads(prose, true), [{type:"text",text:prose}]);
});

test("table completion sends a PNG inline, reuses its receipt, and opt out sends original text", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-completion-tables-"));
  const messages: Array<Record<string, unknown>> = [];
  const server = http.createServer((req,res) => { let body=""; req.on("data",c=>body+=c); req.on("end",()=>{messages.push(JSON.parse(body));res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({status:"ok",retcode:0,data:{message_id:123}}));}); });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address(); assert.ok(address && typeof address==="object");
  const options={rootDir,routeRoot:path.join(rootDir,"data/route"),rolesRoot:path.join(rootDir,"data/roles"),runtimes:[{id:"route",enabled:true,napcatInstances:[{id:"qq",enabled:true,httpUrl:`http://127.0.0.1:${address.port}`,accessToken:""}]}]};
  const hook={...event,lastAssistantMessage:"前文\n\n| 路径 | 实测 |\n|---|---:|\n| LateUpdate | **1.061ms/帧** |\n| StaticShadow | 2793次/帧 |\n\n后文"};
  try {
    await deliverCompletionToEndpoint(owner.rule,hook,"table-receipt","route",withTestEndpointEgress(options));
    await deliverCompletionToEndpoint(owner.rule,hook,"table-receipt","route",withTestEndpointEgress(options));
    assert.equal(messages.length,1);
    const segments=messages[0].message as Array<{type:string;data:Record<string,string>}>;
    assert.deepEqual(segments.map(s=>s.type),["text","image","text"]);
    assert.match(segments[0].data.text,/前文/); assert.match(segments[2].data.text,/后文/);
    assert.match(segments[1].data.file,/^base64:\/\/iVBOR/);
    const disabled={...owner.rule,destination:{...owner.rule.destination,params:{...owner.rule.destination.params,renderTables:"false"}}};
    await deliverCompletionToEndpoint(disabled,hook,"table-disabled","route",withTestEndpointEgress(options));
    assert.match(JSON.stringify(messages[1]),/LateUpdate/);
    assert.doesNotMatch(JSON.stringify(messages[1]),/base64:\/\//);
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));fs.rmSync(rootDir,{recursive:true,force:true});}
});

test("diagram completion payloads preserve prose/image order and opt out leaves source intact", () => {
  const diagram = "```mermaid\nflowchart TD\n A[开始] --> B[完成]\n```\n";
  const body = "正文之前\n\n" + diagram + "\n正文之后";
  const [payload] = completionMessagePayloads(body, true);
  assert.equal(payload.type, "image");
  const segments = payload.segments as Array<{type:string;text:string}>;
  assert.deepEqual(segments.map(segment => segment.type), ["text", "markdown", "text"]);
  assert.equal(segments.map(segment => segment.text).join(""), body);
  assert.deepEqual(completionMessagePayloads(body, false), [{type:"text",text:body}]);
  const long = completionMessagePayloads("段落\n".repeat(1800) + diagram + body, true);
  assert.ok(long.length > 1);
  assert.equal(long.flatMap(part => part.type === "text" ? [String(part.text)] : (part.segments as typeof segments).map(segment => segment.text)).join(""), "段落\n".repeat(1800) + diagram + body);
});


test("completion sends real Mermaid PNG inline to QQ and reuses the mixed-message receipt", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-completion-diagrams-"));
  const messages: Array<Record<string, unknown>> = [];
  const server = http.createServer((req,res) => {let body="";req.on("data",c=>body+=c);req.on("end",()=>{messages.push(JSON.parse(body));res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({status:"ok",retcode:0,data:{message_id:123}}));});});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address();assert.ok(address && typeof address==="object");
  const options={rootDir,routeRoot:path.join(rootDir,"data/route"),rolesRoot:path.join(rootDir,"data/roles"),runtimes:[{id:"route",enabled:true,napcatInstances:[{id:"qq",enabled:true,httpUrl:`http://127.0.0.1:${address.port}`,accessToken:""}]}]};
  const hook={...event,lastAssistantMessage:"前文\n\n```mermaid\nflowchart TD\n A[开始] --> B[结束]\n```\n\n后文"};
  try {
    await deliverCompletionToEndpoint(owner.rule,hook,"mixed-receipt","route",withTestEndpointEgress(options));
    await deliverCompletionToEndpoint(owner.rule,hook,"mixed-receipt","route",withTestEndpointEgress(options));
    assert.equal(messages.length,1);
    const segments=messages[0].message as Array<{type:string;data:Record<string,string>}>;
    assert.deepEqual(segments.map(s=>s.type),["text","image","text"]);
    assert.match(segments[0].data.text,/前文/);assert.match(segments[2].data.text,/后文/);
    assert.match(segments[1].data.file,/^base64:\/\/iVBOR/);
    await deliverCompletionToEndpoint(owner.rule,{...hook,lastAssistantMessage:"前文\n\n```mermaid\nINVALID DIAGRAM !\n```\n\n后文"},"mixed-invalid","route",withTestEndpointEgress(options));
    assert.match(JSON.stringify(messages[1]),/图表转换失败/);
    assert.match(JSON.stringify(messages[1]),/后文/);
    const chain = Array.from({length: 12}, (_, i) => `N${i}[\"保存阶段${i}确认结果\"]`).join("\n")
      + "\n" + Array.from({length: 11}, (_, i) => `N${i} --> N${i + 1}`).join("\n");
    const longHook = {...hook, lastAssistantMessage: `前文\n\n\`\`\`mermaid\nflowchart TD\n${chain}\n\`\`\`\n\n后文`};
    await deliverCompletionToEndpoint(owner.rule,longHook,"mixed-long-diagram","route",withTestEndpointEgress(options));
    await deliverCompletionToEndpoint(owner.rule,longHook,"mixed-long-diagram","route",withTestEndpointEgress(options));
    assert.equal(messages.length, 3, "all diagram pages share the original mixed-message receipt");
    const pages = messages[2].message as Array<{type:string;data:Record<string,string>}>;
    const imageCount = pages.filter(segment => segment.type === "image").length;
    assert.ok(imageCount > 1);
    assert.match(pages[0].data.text, /前文/); assert.match(pages.at(-1)!.data.text, /后文/);
    for (let i = 1; i <= imageCount; i++) assert.ok(pages.some(segment => segment.type === "text" && segment.data.text.includes(`[流程图 ${i}/${imageCount}]`)));
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));fs.rmSync(rootDir,{recursive:true,force:true});}
});


test("unlabelled Mermaid diagrams are recognized while other fenced code remains text", () => {
  for (const source of ["flowchart TD\n A --> B", "architecture-beta\n service api(server)[API]"]) {
    assert.equal(completionMessagePayloads("```\n" + source + "\n```",true)[0].type,"image");
  }
  const source="```ts\nconst graph = 'flowchart';\n```";
  assert.deepEqual(completionMessagePayloads(source,true),[{type:"text",text:source}]);
});


test("existing Markdown images preserve inline order, including nested formatting and code examples", () => {
  const source="Before `![example](not-an-image.png)` **![photo](https://example.test/a.png)** after\n\n![local](<C:/demo/a b.png>)";
  const [payload]=completionMessagePayloads(source,false);
  const segments=payload.segments as Array<any>;
  assert.equal(payload.type,"image");
  assert.deepEqual(segments.filter(s=>s.type==="image"),[{type:"image",url:"https://example.test/a.png"},{type:"image",path:path.normalize("C:/demo/a b.png")}]);
  assert.match(segments[0].text,/`!\[example\]/);
  assert.deepEqual(completionLocalFiles("![image](C:/demo/a.png) [file](C:/demo/report.md)"),[path.normalize("C:/demo/report.md")]);
  const native=completionMessagePayloads("Caption",false,undefined,["base64://abc","base64://abc"]);
  assert.deepEqual((native[0].segments as Array<any>).map(s=>s.type),["text","image"]);
});

test("QQ completion preserves original local and native images with text and reuses the mixed receipt", async () => {
  const rootDir=fs.mkdtempSync(path.join(os.tmpdir(),"completion-images-send-"));
  const calls:Array<any>=[];
  const server=http.createServer((req,res)=>{let body="";req.on("data",c=>body+=c);req.on("end",()=>{calls.push(JSON.parse(body));res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({status:"ok",retcode:0,data:{message_id:calls.length}}));});});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();assert.ok(address&&typeof address==="object");
  const options={rootDir,routeRoot:path.join(rootDir,"data/route"),rolesRoot:path.join(rootDir,"data/roles"),runtimes:[{id:"route",enabled:true,napcatInstances:[{id:"qq",enabled:true,httpUrl:`http://127.0.0.1:${address.port}`,accessToken:""}]}]};
  const png=Buffer.from([137,80,78,71,13,10,26,10,0]);const file=path.join(rootDir,"photo.png");fs.writeFileSync(file,png);
  const hook={...event,lastAssistantMessage:`Before\n\n![photo](<${file}>)\n\nAfter`};
  const context={plans:[],images:["base64://"+Buffer.concat([png,Buffer.from([1])]).toString("base64")]};
  try{
    for(const target of ["group","private"]){
      const rule={...owner.rule,destination:{...owner.rule.destination,params:{...owner.rule.destination.params,target,renderDiagrams:"false"}}};
      await deliverCompletionToEndpoint(rule,hook,"photos-"+target,"route",withTestEndpointEgress(options),context);
      await deliverCompletionToEndpoint(rule,hook,"photos-"+target,"route",withTestEndpointEgress(options),context);
    }
    assert.equal(calls.length,2);
    for(const call of calls){const segments=call.message as Array<any>;assert.deepEqual(segments.map(s=>s.type),["text","image","text","image"]);assert.match(segments[0].data.text,/Before/);assert.match(segments[2].data.text,/After/);assert.equal(segments[3].data.file,context.images[0]);}
    await assert.rejects(deliverCompletionToEndpoint(owner.rule,{...event,lastAssistantMessage:"Text remains available"},"image-read-failed","route",withTestEndpointEgress(options),{plans:[],imageReadError:true}),/正文已发送/);
    assert.equal(calls.length,3);
    assert.match(String(calls[2].message),/Text remains available/);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));fs.rmSync(rootDir,{recursive:true,force:true});}
});


test("Desktop slash-prefixed Windows links resolve to actual drive paths", () => {
  assert.deepEqual(completionLocalFiles("[报告](</C:/Reports/报告.md>)"), [path.normalize("C:/Reports/报告.md")]);
  const [payload] = completionMessagePayloads("![截图](</C:/Reports/截图.png>)", false);
  assert.deepEqual(payload.segments, [{type:"image",path:path.normalize("C:/Reports/截图.png")}]);
});
