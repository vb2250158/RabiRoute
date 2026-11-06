import assert from "node:assert/strict";
import { promises as fs, watch } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import test from "node:test";
import { createXiaomiHomeGatewayDelivery, type XiaomiHomeGatewayExecution } from "./gatewayDelivery.js";
import { installDataMutationAuditSink } from "../../../../../observability/dataMutationAudit.js";
import { buildXiaomiHomeEventRecord, xiaomiHomeEventTemplateValues } from "../../xiaomiHomeEventDelivery.js";
import { SYSTEM_EVENT_STDIN_FLAG, SYSTEM_EVENT_RESULT_PREFIX } from "../../../../../shared/systemEventIngress.js";
import { listenManagerEndpoint } from "../../../../../managerEndpointPolicy.js";

const event = { id: "original-event", kind: "sensor_alert" as const, resourceId: "home:ha:sensor.test", resourceName: "Test sensor", areaName: "Test room", homeId: "controlled-home", artifactId: "fixture-artifact", occurredAt: "2026-11-03T00:00:00Z", summary: "Controlled local event" };

async function realCliEnvironment(t: test.TestContext, root: string, stale = false) {
  const identity = { applicationGenerationId: "xiaomi-test-generation", managerInstanceId: "xiaomi-test-manager" };
  const probes: string[] = [];
  let baseUrl = "";
  const server = http.createServer((request, response) => {
    probes.push(request.url || "");
    assert.equal(request.headers["x-rabiroute-expected-application-generation-id"], identity.applicationGenerationId);
    assert.equal(request.headers["x-rabiroute-expected-manager-instance-id"], identity.managerInstanceId);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ...identity, ...(stale ? { managerInstanceId: "replacement-manager" } : {}), managerBaseUrl: baseUrl,
      backgroundLifecycle: { planStorageStartup: { state: "ready" } } }));
  });
  const endpoint = await listenManagerEndpoint({ server, host: "127.0.0.1", policy: { mode: "auto" } });
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  assert.equal(endpoint.port, address.port);
  baseUrl = endpoint.baseUrl;
  const profilePath = path.join(root, "test-profile.json");
  await fs.writeFile(profilePath, JSON.stringify({ schemaVersion: 2, readyRequires: [], instances: [] }));
  const environment: NodeJS.ProcessEnv = { ...process.env,
    RABIROUTE_STATE_ROOT: root, RABIROUTE_PACKAGE_ROOT: process.cwd(),
    RABIROUTE_PLUGIN_PROFILE: profilePath, RABIROUTE_PLUGIN_PACKAGE_ROOTS: path.join(root, "packages"),
    RABIROUTE_ROUTE_SNAPSHOT_PATH: undefined, RABIROUTE_ROUTE_REVISION: undefined,
    GATEWAY_ID: "original-route", GATEWAY_MANAGER_URL: baseUrl,
    RABIROUTE_APPLICATION_GENERATION_ID: identity.applicationGenerationId, RABIROUTE_MANAGER_INSTANCE_ID: identity.managerInstanceId,
    DATA_DIR: path.join(root, "gateway-data"), ROLES_DIR: path.join(root, "roles"), AGENT_ROLE_ID: "TestRole",
    AGENT_ROLE_DEVICE_ID: undefined, ROUTE_PROFILES: "[]", NOTIFICATION_RULES: "[]", AUTOMATION_RULES: "[]", AGENT_ADAPTERS: "",
    MESSAGE_ADAPTER_TYPE: "xiaomiHome", MESSAGE_ADAPTER_TYPES: '["xiaomiHome"]'
  };
  return { environment, probes };
}

const realCliCommand = (args: string[]) => ({ command: process.execPath, shell: false,
  args: ["--import", import.meta.resolve("tsx"), path.resolve("src/index.ts"), ...args] });

async function runRealCli(root: string, environment: NodeJS.ProcessEnv, payload: unknown) {
  const command = realCliCommand([SYSTEM_EVENT_STDIN_FLAG]);
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command.command, command.args, { cwd: root, env: environment, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`System event CLI timed out: ${stderr}`)); }, 60_000);
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("close", code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

test("Xiaomi plugin enters the real child CLI through its original enabled Route and retains normalized event identity", { timeout: 120_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiaomi-gateway-owner-"));
  const logs: string[] = [];
  let owner: ReturnType<typeof createXiaomiHomeGatewayDelivery> | undefined;
  t.after(async () => { await owner?.stop(); await fs.rm(root, { recursive: true, force: true }); });
  t.after(installDataMutationAuditSink(() => {}));
  const cli = await realCliEnvironment(t, root);
  const execution: XiaomiHomeGatewayExecution = {
    rootDir: root,
    routeSnapshots: () => [
      { definition: { id: "original-route", gatewayPort: 8790, agentRoleId: "TestRole", messageAdapters: ["xiaomiHome"] } },
      { definition: { id: "disabled-route", gatewayPort: 8791, agentRoleId: "TestRole", messageAdapters: ["xiaomiHome"], enabled: false } },
      { definition: { id: "other-role", gatewayPort: 8792, agentRoleId: "OtherRole", messageAdapters: ["xiaomiHome"] } },
      { definition: { id: "other-endpoint", gatewayPort: 8793, agentRoleId: "TestRole", messageAdapters: ["webhook"] } }
    ],
    childCommand(args) {
      assert.deepEqual(args, [SYSTEM_EVENT_STDIN_FLAG]);
      return realCliCommand(args);
    },
    environmentForGateway: definition => { assert.equal(definition.id, "original-route"); return cli.environment; },
    appendLog(id, message) { logs.push(`${id}:${message}`); }
  };
  owner = createXiaomiHomeGatewayDelivery(execution, () => root);
  const results = await owner.deliverEvent(event, { agentRoleId: "TestRole" });
  assert.deepEqual(results.map(result => [result.gatewayId, result.status, result.reason]), [["original-route", "missed", "no_active_route_profile"]]);
  assert.deepEqual(cli.probes, ["/health"]);
  const attempt = JSON.parse((await fs.readFile(path.join(root, "gateway-data/delivery-replay-ledger.jsonl"), "utf8")).trim());
  assert.equal(attempt.routeKind, "xiaomi_home_event");
  assert.equal(attempt.messageId, event.id);
  assert.deepEqual(attempt.record, buildXiaomiHomeEventRecord(event));
  assert.deepEqual(attempt.extraValues, xiaomiHomeEventTemplateValues(event));
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /^original-route:/);
  const ledger = await fs.readFile(path.join(root, "xiaomi-home-events.jsonl"), "utf8");
  assert.equal(JSON.parse(ledger).id, event.id);
  await owner.stop();
  await assert.rejects(owner.deliverEvent(event, { agentRoleId: "TestRole" }), /retired/);
  assert.equal(await fs.readFile(path.join(root, "xiaomi-home-events.jsonl"), "utf8"), ledger);
});

test("real event child rejects a replaced Manager generation before forwarding or writing a replay attempt", { timeout: 120_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiaomi-cli-generation-"));
  const cli = await realCliEnvironment(t, root, true);
  const owner = createXiaomiHomeGatewayDelivery({ rootDir: root,
    routeSnapshots: () => [{ definition: { id: "original-route", gatewayPort: 8790, agentRoleId: "TestRole", messageAdapters: ["xiaomiHome"] } }],
    childCommand: realCliCommand, environmentForGateway: () => cli.environment, appendLog() {}
  }, () => root);
  t.after(async () => { await owner.stop(); await fs.rm(root, { recursive: true, force: true }); });
  t.after(installDataMutationAuditSink(() => {}));
  const result = await owner.deliverEvent(event, { agentRoleId: "TestRole" });
  assert.equal(result[0]?.reason, "delivery_process_no_result");
  assert.deepEqual(cli.probes, ["/health"]);
  await assert.rejects(fs.stat(path.join(root, "gateway-data/delivery-replay-ledger.jsonl")), { code: "ENOENT" });
  assert.equal(JSON.parse((await fs.readFile(path.join(root, "xiaomi-home-events.jsonl"), "utf8")).trim()).id, event.id);
});

test("plugin normalization rejection preserves the original per-Route failure without spawning or replacing the event", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiaomi-normalization-"));
  const owner = createXiaomiHomeGatewayDelivery({ rootDir: root,
    routeSnapshots: () => [{ definition: { id: "original-route", gatewayPort: 8790, agentRoleId: "TestRole", messageAdapters: ["xiaomiHome"] } }],
    childCommand() { throw new Error("Invalid platform input must not spawn a child."); }, environmentForGateway: () => ({}), appendLog() {}
  }, () => root);
  t.after(async () => { await owner.stop(); await fs.rm(root, { recursive: true, force: true }); });
  t.after(installDataMutationAuditSink(() => {}));
  assert.deepEqual(await owner.deliverEvent({ ...event, resourceId: "invalid" }, { agentRoleId: "TestRole" }), [
    { gatewayId: "original-route", status: "failed", matchedRuleCount: 0, sentPacketCount: 0, reason: "delivery_process_no_result" }
  ]);
});

test("real generic event CLI accepts another normalized event kind and rejects malformed input with the original exit semantics", { timeout: 120_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "generic-event-cli-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cli = await realCliEnvironment(t, root);
  const payload = { routeKind: "wearable_health_alert", record: { messageId: "generic-event", time: 1793664000, rawMessage: "Controlled normalized event", source: "fixture" }, templateValues: { controlled: "value" } };
  const success = await runRealCli(root, cli.environment, payload);
  assert.equal(success.code, 0, success.stderr);
  const line = success.stdout.split(/\r?\n/).find(item => item.startsWith(SYSTEM_EVENT_RESULT_PREFIX));
  assert.ok(line, success.stdout + success.stderr);
  assert.deepEqual(JSON.parse(line.slice(SYSTEM_EVENT_RESULT_PREFIX.length)), {
    status: "missed", matchedRuleCount: 0, sentPacketCount: 0, reason: "no_active_route_profile", adapterOutcomes: []
  });
  const ledgerPath = path.join(root, "gateway-data/delivery-replay-ledger.jsonl");
  const before = await fs.readFile(ledgerPath, "utf8");
  const attempt = JSON.parse(before.trim());
  assert.equal(attempt.routeKind, payload.routeKind);
  assert.deepEqual(attempt.record, payload.record);
  assert.deepEqual(attempt.extraValues, payload.templateValues);
  const invalid = await runRealCli(root, cli.environment, { ...payload, record: { ...payload.record, rawMessage: "" } });
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /System event ingress payload is incomplete/);
  assert.ok(!invalid.stdout.includes(SYSTEM_EVENT_RESULT_PREFIX));
  assert.equal(await fs.readFile(ledgerPath, "utf8"), before);
});

test("retiring the Xiaomi plugin terminates and joins its own in-flight delivery worker", { timeout: 15_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiaomi-worker-retire-"));
  let owner: ReturnType<typeof createXiaomiHomeGatewayDelivery> | undefined;
  t.after(async () => { await owner?.stop(); await fs.rm(root, { recursive: true, force: true }); });
  t.after(installDataMutationAuditSink(() => {}));
  const pidFile = path.join(root, "worker.pid");
  const watcher = watch(root);
  t.after(() => watcher.close());
  const ready = new Promise<number>((resolve, reject) => watcher.on("change", (_event, filename) => {
    if (filename?.toString() !== "worker.pid") return;
    void fs.readFile(pidFile, "utf8").then(text => {
      const pid = Number(text);
      if (/^[1-9]\d*\n$/.test(text) && Number.isSafeInteger(pid)) resolve(pid);
    }, reject);
  }));
  owner = createXiaomiHomeGatewayDelivery({
    rootDir: root, routeSnapshots: () => [{ definition: { id: "original-route", gatewayPort: 8790, agentRoleId: "TestRole", messageAdapters: ["xiaomiHome"] } }],
    childCommand: () => ({ command: process.execPath, shell: false, args: ["-e", 'require("node:fs").writeFileSync(process.env.TEST_XIAOMI_WORKER_PID,String(process.pid)+"\\n");setInterval(()=>{},1000)'] }),
    environmentForGateway: () => ({ ...process.env, TEST_XIAOMI_WORKER_PID: pidFile }), appendLog() {}
  }, () => root);
  const pending = owner.deliverEvent(event, { agentRoleId: "TestRole" });
  const pid = await ready;
  await owner.stop();
  assert.equal((await pending)[0]?.reason, "delivery_plugin_retired");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
