import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGatewayControlOwner, type GatewayControlRoutesContext } from "../plugins/io.rabiroute.manager.gateway-runtime/src/manager/gatewayControlRoutes.js";
import { RouteCatalogStartupLifecycle } from "./routeCatalogStartupLifecycle.js";
import { executeRouteCatalogTransaction, type RouteCatalogSnapshot } from "./routeCatalogTransaction.js";
import { ManagerGatewayRuntimeService } from "./managerGatewayRuntimeService.js";
import { createGatewayRouteActivationOwner, type GatewayRouteActivationRuntime } from "./gatewayRouteActivationOwner.js";
import { gatewayRouteSnapshotRevision } from "../shared/gatewayRouteSnapshot.js";
import { writeGatewayRouteBootSnapshot } from "../shared/gatewayRouteSnapshotBoot.js";
import type { GatewayDefinition } from "../shared/gatewayConfigModel.js";

test("formal save crosses durable catalog CAS, original queue context and a resident process; lost ACK resolves without replay", async t => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-route-save-activation-"));
  const routeRoot = path.join(rootDir, "data/route"), rolesRoot = path.join(rootDir, "data/roles");
  const input = { rootDir, routeRoot, rolesRoot, managerPort: 31337, readOnly: false };
  let installed: RouteCatalogSnapshot = executeRouteCatalogTransaction({ ...input, requestId: "seed", attemptToken: "seed", operationId: "seed",
    operation: { kind: "replace", config: { gateways: [{ id: "route", configName: "route", enabled: true, gatewayPort: 23001, messageAdapters: ["webhook"], webhookPort: 23002, webhookPath: "/before" }] } }
  });
  const original = installed.gateways[0]!;
  const boot = writeGatewayRouteBootSnapshot(path.join(rootDir, "boot"), "original-generation", original);
  const effectsPath = path.join(rootDir, "effects.txt");
  const receiverUrl = new URL("../runtime/gatewayRouteSnapshotReceiver.ts", import.meta.url).href;
  const bootUrl = new URL("../shared/gatewayRouteSnapshotBoot.ts", import.meta.url).href;
  const childSource = `
    import fs from 'node:fs';
    import {Writable} from 'node:stream';
    import {bindGatewayRouteSnapshotReceiver} from ${JSON.stringify(receiverUrl)};
    import {readGatewayRouteBootSnapshot} from ${JSON.stringify(bootUrl)};
    const definition=readGatewayRouteBootSnapshot(process.env.RABIROUTE_ROUTE_SNAPSHOT_PATH,process.env.RABIROUTE_ROUTE_REVISION,'route');
    let drop=true;
    process.stdin.on('data',chunk=>{if(chunk.toString().includes('ALLOW_ACK'))drop=false;});
    const output=new Writable({write(chunk,_encoding,callback){if(!drop)process.stdout.write(chunk);callback();}});
    bindGatewayRouteSnapshotReceiver({identity:{gatewayId:definition.id,gatewayGenerationId:'original-generation',pid:process.pid},
      initialRevision:process.env.RABIROUTE_ROUTE_REVISION,input:process.stdin,output,
      async applySnapshot(_definition,revision){fs.appendFileSync(process.env.TEST_EFFECTS_PATH,revision+'\\n');}});
    console.log('RESIDENT_READY');
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childSource], {
    env: { ...process.env, RABIROUTE_ROUTE_SNAPSHOT_PATH: boot.filename, RABIROUTE_ROUTE_REVISION: boot.revision, TEST_EFFECTS_PATH: effectsPath }, windowsHide: true
  });
  let stderr = ""; child.stderr.on("data", data => { stderr += data; });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Resident did not start: ${stderr}`)), 15000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.stdout.on("data", data => { if (data.toString().includes("RESIDENT_READY")) { clearTimeout(timeout); resolve(); } });
  });
  const residentPid = child.pid!;
  const activation = createGatewayRouteActivationOwner({ timeoutMs: 60,
    declarations: async () => [{ endpointType: "webhook", routeKeys: ["webhookPath"], runtimeFields: { webhookPath: { paths: ["webhookPath"] } } }]
  });
  activation.attach(child, { gatewayId: original.id, gatewayGenerationId: "original-generation", pid: residentPid }, original, boot.revision);
  const runtime: GatewayRouteActivationRuntime = { definition: original, process: child, readiness: "ready", needsRestart: false };
  const runtimes = new Map([[original.id, runtime]]);
  let restarts = 0, nativeWrites = 0;
  const service = new ManagerGatewayRuntimeService<GatewayDefinition, GatewayRouteActivationRuntime>(runtimes, {
    loadDefinitions: () => installed.gateways, normalizeDefinition: definition => definition,
    definitionFingerprint: gatewayRouteSnapshotRevision,
    createRuntime: definition => ({ definition, process: null, readiness: "stopped", needsRestart: false }),
    isRunning: item => Boolean(item.process), reconcileAction: item => item.needsRestart ? "restart" : "none",
    startRuntime() {}, stopRuntime() {}, restartRuntime() { restarts++; }
  });
  const applicationContexts: Array<{ operationId: string; kind: string; resolveOperationId?: string }> = [];
  const lifecycle = new RouteCatalogStartupLifecycle({
    input: () => input,
    attemptFactory(operation, identity) {
      if (operation.kind === "upsert") nativeWrites++;
      return { result: Promise.resolve().then(() => executeRouteCatalogTransaction({ ...input, ...identity, operation })), async cancel() {} };
    },
    async apply(snapshot, context) {
      applicationContexts.push(context);
      service.loadDefinitions(snapshot.gateways);
      await activation.prepare(runtimes.values(), context.resolveOperationId ?? context.operationId, Boolean(context.resolveOperationId), context.kind !== "capture");
      service.reconcile();
      installed = snapshot;
    }
  });
  t.after(async () => {
    await lifecycle.stop(); activation.detach(child);
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, "close"); }
    boot.dispose(); fs.rmSync(rootDir, { recursive: true, force: true });
  });
  await lifecycle.recapture();
  const unused = (): never => { throw new Error("This save/recovery proof must not call an unrelated platform operation."); };
  const context: GatewayControlRoutesContext = {
    gatewayPayload: () => ({ code: 0, data: { config: { gateways: installed.gateways }, manager: [] } }),
    writeGatewayConfig: async (id: string, definition: GatewayDefinition, hash: string, operationId: string) => { await lifecycle.upsert(definition, hash, operationId, id); },
    resolveRouteMutation: async (operationId: string) => {
      const result = await lifecycle.resolveMutation(operationId);
      assert.equal(result.resolvedMutation?.operationId, operationId);
      return { state: result.resolvedMutation!.state };
    },
    syncRunningGateways: () => service.reconcile(),
    routeMutationActivation: activation.receipt,
    routeCatalogVersion: () => ({ contentHash: installed.routeConfigHash, routeConfigHash: installed.routeConfigHash, presentationHash: installed.presentationHash, revision: lifecycle.snapshot().revision ?? 0 }),
    writeConfig: unused, loadRuntimes: unused, runtimeStatuses: unused, networkOptionsPayload: unused,
    startGateway: unused, stopGateway: unused, restartGateway: unused, removeGatewayConfig: unused,
    weixinLoginTarget: unused, requestWeixinLogin: unused, triggerManualRule: unused, testAgentDelivery: unused,
    listDeliveryReplayAttempts: unused, replayDelivery: unused
  };
  const owner = createGatewayControlOwner(context);
  const saved = await owner.save(original.id, { ...original, webhookPath: "/after" }, { operationId: "original-save", contentHash: installed.routeConfigHash });
  const first = saved.body as { receipt: { state: string }; activation: { state: string } };
  assert.equal(saved.status, 200);
  assert.equal(first.receipt.state, "committed");
  assert.equal(first.activation.state, "uncertain");
  const disk = executeRouteCatalogTransaction({ ...input, requestId: "disk-proof", attemptToken: "disk-proof", operationId: "disk-proof", readOnly: true, operation: { kind: "capture" } });
  assert.equal(disk.gateways[0]?.webhookPath, "/after");
  assert.ok(applicationContexts.some(item => item.kind === "upsert" && item.operationId === "original-save"));
  child.stdin.write("ALLOW_ACK\n");
  const resolved = await owner.resolve("original-save");
  const resolution = resolved.body as { receipt: { state: string; operationId: string }; activation: { state: string } };
  assert.equal(resolution.receipt.state, "committed");
  assert.equal(resolution.receipt.operationId, "original-save");
  assert.equal(resolution.activation.state, "applied");
  assert.equal(nativeWrites, 1);
  assert.equal(fs.readFileSync(effectsPath, "utf8").trim().split("\n").length, 1);
  assert.equal(child.pid, residentPid);
  assert.equal(restarts, 0);
  assert.ok(applicationContexts.some(item => item.kind === "capture" && item.resolveOperationId === "original-save"));
});
