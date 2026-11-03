import assert from "node:assert/strict";
import { promises as fs, watch } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createXiaomiHomeGatewayDelivery, type XiaomiHomeGatewayExecution } from "./gatewayDelivery.js";
import { installDataMutationAuditSink } from "../../observability/dataMutationAudit.js";

const event = { id: "original-event", kind: "sensor_alert" as const, resourceId: "home:ha:sensor.test", resourceName: "Test sensor", occurredAt: "2026-11-03T00:00:00Z", summary: "Controlled local event" };

test("Xiaomi plugin delivers only through its original enabled Route and retains the existing event ledger", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiaomi-gateway-owner-"));
  const logs: string[] = [];
  let owner: ReturnType<typeof createXiaomiHomeGatewayDelivery> | undefined;
  t.after(async () => { await owner?.stop(); await fs.rm(root, { recursive: true, force: true }); });
  t.after(installDataMutationAuditSink(() => {}));
  const execution: XiaomiHomeGatewayExecution = {
    rootDir: root,
    routeSnapshots: () => [
      { definition: { id: "original-route", gatewayPort: 8790, agentRoleId: "TestRole", messageAdapters: ["xiaomiHome"] } },
      { definition: { id: "disabled-route", gatewayPort: 8791, agentRoleId: "TestRole", messageAdapters: ["xiaomiHome"], enabled: false } },
      { definition: { id: "other-role", gatewayPort: 8792, agentRoleId: "OtherRole", messageAdapters: ["xiaomiHome"] } },
      { definition: { id: "other-endpoint", gatewayPort: 8793, agentRoleId: "TestRole", messageAdapters: ["webhook"] } }
    ],
    childCommand(args) {
      assert.deepEqual(args, ["--xiaomi-home-event-stdin"]);
      return { command: process.execPath, shell: false, args: ["-e", 'process.stdin.resume();process.stdin.on("end",()=>console.log("RABIROUTE_XIAOMI_HOME_DELIVERY_RESULT:"+JSON.stringify({status:"routed",matchedRuleCount:1,sentPacketCount:1})))'] };
    },
    environmentForGateway: () => ({ ...process.env }),
    appendLog(id, message) { logs.push(`${id}:${message}`); }
  };
  owner = createXiaomiHomeGatewayDelivery(execution, () => root);
  const results = await owner.deliverEvent(event, { agentRoleId: "TestRole" });
  assert.deepEqual(results.map(result => [result.gatewayId, result.status]), [["original-route", "routed"]]);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /^original-route:/);
  const ledger = await fs.readFile(path.join(root, "xiaomi-home-events.jsonl"), "utf8");
  assert.equal(JSON.parse(ledger).id, event.id);
  await owner.stop();
  await assert.rejects(owner.deliverEvent(event, { agentRoleId: "TestRole" }), /retired/);
  assert.equal(await fs.readFile(path.join(root, "xiaomi-home-events.jsonl"), "utf8"), ledger);
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
