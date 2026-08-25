import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { once } from "node:events";
import { createRabiManagerPluginHostApi } from "./managerPluginPackageHost.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";

async function fixture(): Promise<Readonly<{
  server: http.Server;
  baseUrl: string;
  registry: ManagerPluginRouteRegistry;
  close(): Promise<void>;
}>> {
  const registry = new ManagerPluginRouteRegistry();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (!registry.handle(request, url, response)) response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server address is unavailable.");
  return Object.freeze({
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    registry,
    close: async () => { server.close(); await once(server, "close"); }
  });
}

test("package host scopes routes, drains requests, and emits a namespaced event", async () => {
  const value = await fixture();
  const events: unknown[] = [];
  const api = createRabiManagerPluginHostApi({
    instanceId: "manager:sample",
    routes: value.registry,
    publishManagerEvent: (_type, data) => events.push(data)
  });
  api.registerRoutes([{
    routeId: "sample",
    match: { kind: "exact", path: "/api/plugins/sample", methods: ["GET"] },
    handler: (_request, _url, response) => {
      api.json(response, 200, { code: 0, data: { instanceId: api.instanceId } });
      return true;
    }
  }]);
  const response = await fetch(`${value.baseUrl}/api/plugins/sample`);
  assert.deepEqual(await response.json(), { code: 0, data: { instanceId: "manager:sample" } });
  api.publish("sample.ready", { revision: 1 });
  assert.deepEqual(events, [{ instanceId: "manager:sample", name: "sample.ready", data: { revision: 1 } }]);
  await api.stop();
  assert.equal((await fetch(`${value.baseUrl}/api/plugins/sample`)).status, 404);
  await value.close();
});

test("package host rejects invalid event names and route work after stop", async () => {
  const value = await fixture();
  const api = createRabiManagerPluginHostApi({
    instanceId: "manager:sample",
    routes: value.registry,
    publishManagerEvent: () => {}
  });
  assert.throws(() => api.publish("bad name", {}), /event name is invalid/);
  await api.stop();
  assert.throws(() => api.registerRoutes([]), /is stopping/);
  await assert.rejects(api.track(Promise.resolve()), /is stopping/);
  await value.close();
});
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RabiCordisHost } from "../runtime/cordisHost.js";
import { mountManagerPluginRuntime } from "../runtime/managerPluginRuntime.js";
import { loadManagerPluginProfile } from "./managerPluginPackageLoader.js";
import { parseRabiPluginProfile } from "./pluginProfile.js";

test("example package is loaded through the scoped host and releases its route with its Fiber", async () => {
  const value = await fixture();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabiroute-manager-example-"));
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "examples", "plugin-bundles", "manager-echo");
  const packageDir = path.join(root, "packages", encodeURIComponent("example.manager.echo"), "1.0.0");
  await fs.mkdir(path.dirname(packageDir), { recursive: true });
  await fs.cp(source, packageDir, { recursive: true });
  const events: unknown[] = [];
  const loaded = await loadManagerPluginProfile({
    packageRoot: path.join(root, "packages"),
    runtimeRoot: path.join(root, "runtime"),
    profile: parseRabiPluginProfile({
      schemaVersion: 1,
      plugins: [{
        id: "manager:example-echo",
        package: "example.manager.echo",
        version: "1.0.0",
        enabled: true,
        config: { message: "hello" }
      }]
    }),
    createServices: identity => createRabiManagerPluginHostApi({
      instanceId: identity.instanceId,
      routes: value.registry,
      publishManagerEvent: (_type, data) => events.push(data)
    })
  });
  const cordis = new RabiCordisHost();
  const runtime = await mountManagerPluginRuntime(cordis);
  const mounted = await runtime.mount(loaded[0]!.definition);
  const response = await fetch(`${value.baseUrl}/api/plugins/example-echo`);
  const body = await response.json() as { data: { config: { message: string } } };
  assert.equal(response.status, 200);
  assert.equal(body.data.config.message, "hello");
  assert.deepEqual(events, [{
    instanceId: "manager:example-echo",
    name: "echo.ready",
    data: { revision: loaded[0]!.context.bundle.revision }
  }]);
  await mounted.unmount();
  assert.equal((await fetch(`${value.baseUrl}/api/plugins/example-echo`)).status, 404);
  await runtime.unmount();
  await cordis.dispose();
  await value.close();
  await fs.rm(root, { recursive: true, force: true });
});
