import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { MessageEndpointEgressProvider } from "@rabiroute/plugin-sdk";
import { GenerationRuntime } from "../../plugin-kernel/generationRuntime.js";
import { parsePluginManifest } from "../../plugin-kernel/manifest.js";
import type { PluginCandidate, PluginModule } from "../../plugin-kernel/types.js";
import { createMessageEndpointHostPorts } from "../../runtime/messageEndpointHostPorts.js";
import { MessageAdapterScanProviderRegistry } from "../../manager/messageAdapterControl.js";
import { ManagerPluginRouteRegistry } from "../../manager/managerPluginRouteRegistry.js";
import { markAuthenticatedConnectionRequest } from "../../manager/connectionRequestAccess.js";

test("the real bundled mobile endpoint owns HTTP state APIs; disabling it leaves shared transport running", { timeout: 60000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mobile-endpoint-owner-"));
  const source = path.resolve("plugins/builtin/io.rabiroute.endpoint.rabilink/1.0.0");
  // @ts-expect-error Production JavaScript builder is outside src.
  const { bundleMessageEndpointRuntime } = await import("../../../scripts/build-message-endpoint-runtime.mjs");
  const spec = JSON.parse(await fs.readFile(path.join(source, "manager-runtime.build.json"), "utf8"));
  await fs.writeFile(path.join(root, "manager-runtime.mjs"), (await bundleMessageEndpointRuntime(process.cwd(), spec)).contents);
  const egressSpec = JSON.parse(await fs.readFile(path.join(source, "egress-runtime.build.json"), "utf8"));
  await fs.writeFile(path.join(root, "egress-runtime.mjs"), (await bundleMessageEndpointRuntime(process.cwd(), egressSpec)).contents);
  await fs.writeFile(path.join(root, "manager.mjs"), (await fs.readFile(path.join(source, "manager.mjs"), "utf8"))
    .replace('"@rabiroute/plugin-sdk"', JSON.stringify(pathToFileURL(path.resolve("plugins/contracts/plugin-sdk/index.mjs")).href)));
  const entry = await import(pathToFileURL(path.join(root, "manager.mjs")).href) as PluginModule;
  const modules = new Map<PluginCandidate, PluginModule>();
  const operations = new ManagerPluginRouteRegistry(), scans = new MessageAdapterScanProviderRegistry();
  let transportStarts = 0, transportStops = 0;
  const connection = { snapshot: () => ({ deviceId: "test-pc", deviceGuid: "test-guid", scope: "test-scope", generation: "test-generation" }),
    authorize: () => ({ sourceDeviceId: "test-phone", deviceOwner: "test-pc", scope: "test-scope" }),
    applicationOwnerTarget: async () => "test-pc", peers: async () => [] };
  let unrelatedLoads = 0;
  const ports = await createMessageEndpointHostPorts({loaders: {codexRuntime: async () => {unrelatedLoads++; throw new Error("The unrelated inbound-only owner is unavailable.");}}});
  const kernel = new GenerationRuntime({ host: "manager", hostServices: [{ capability: "host.message-endpoints@1", value: {
    ...ports, scanProviders: scans, operations, manager: { rootDir: root }, routeSnapshots: () => []
  } }], executor: { async prepare(candidate) { return modules.get(candidate)!; } } });
  const endpoint: PluginCandidate = { instanceId: "endpoint:rabilink", revision: "mobile-one", config: {},
    manifest: parsePluginManifest(JSON.parse(await fs.readFile(path.join(source, "rabi.plugin.json"), "utf8"))),
    entry: { execution: "in_process", path: path.join(root, "manager.mjs") } };
  modules.set(endpoint, entry);
  const transport: PluginCandidate = { instanceId: "shared-transport", revision: "shared-one", config: {},
    manifest: { schemaVersion: 2, id: "io.test.shared-transport", version: "1.0.0", entries: { manager: { execution: "in_process", module: "./manager.mjs" } }, provides: ["manager.rabilink-relay@1"], requires: [], optional: [], permissions: [] },
    entry: { execution: "in_process", path: "fixture" } };
  modules.set(transport, { activate(context) { context.services.provide("manager.rabilink-relay@1", { connection }); context.effects.add(() => { transportStarts++; return () => { transportStops++; }; }); } });
  const server = http.createServer((request, response) => {
    if (request.url === "/worker/messages") {
      request.resume(); request.on("end", () => response.writeHead(200, {"content-type": "application/json"}).end(JSON.stringify({messages: [{id: "native-mobile-egress"}]})));
      return;
    }
    markAuthenticatedConnectionRequest(request, () => {});
    if (!operations.handle(request, new URL(request.url!, "http://localhost"), response)) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as {port: number}).port}/api/rabilink/mobile/asr-settings`;
  try {
    await kernel.switch([transport, endpoint]);
    const outbound = kernel.current().services.services.get("endpoint.rabilink.egress@1")!.value as MessageEndpointEgressProvider;
    const lease = outbound.acquire({deliveryId: "native-mobile-egress"});
    try {
      const sent = await lease.call<{messages: Array<{id: string}>}>("publishRabiLinkRelayMessage", ["Actual physical egress bundle", {deliveryId: "native-mobile-egress", relay: {url: `http://127.0.0.1:${(server.address() as {port: number}).port}`, token: "fixture-only-token"}}]);
      assert.equal(sent.messages[0]?.id, "native-mobile-egress");
      assert.equal(unrelatedLoads, 0, "Unused inbound dependencies never participate in egress activation.");
    } finally {lease.release();}
    const activation = kernel.current().records.find(record => record.identity.instanceId === "shared-transport")!.identity.activationId;
    assert.equal((await fetch(url)).status, 200);
    const saved = await fetch(url, { method: "PATCH", headers: { "content-type": "application/json", "idempotency-key": "mobile-own-settings" }, body: JSON.stringify({ priority: [] }) });
    assert.equal(saved.status, 200, await saved.text());
    const mobile = kernel.current().services.services.get("endpoint.rabilink@1")!.value as {runAcceptedWork<T>(operation: () => Promise<T>): Promise<T>};
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const accepted = mobile.runAcceptedWork(async () => {await gate; return "original mobile dispatch";});
    const stopping = kernel.switch([transport]);
    while (kernel.current().services.services.has("endpoint.rabilink@1")) await new Promise(resolve => setTimeout(resolve, 5));
    await assert.rejects(mobile.runAcceptedWork(async () => "new dispatch"), /disabled|retiring/);
    assert.equal(transportStops, 0);
    assert.equal(kernel.current().records.find(record => record.identity.instanceId === "shared-transport")!.identity.activationId, activation);
    finish();
    assert.equal(await accepted, "original mobile dispatch");
    await stopping;
    assert.equal((await fetch(url)).status, 404);
    assert.equal(transportStops, 0);
    assert.equal(kernel.current().records.find(record => record.identity.instanceId === "shared-transport")!.identity.activationId, activation);
    await kernel.switch([transport, endpoint]);
    const restored = await fetch(url);
    assert.equal(restored.status, 200);
    assert.deepEqual((await restored.json() as {priority: unknown}).priority, []);
    assert.equal(transportStarts, 1);
    assert.equal(transportStops, 0);
  } finally {
    await kernel.dispose();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
  assert.equal(transportStops, 1);
});
