import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { LanAgentRegistry } from "./lanAgentRegistry.js";
import { createLanAgentTerminalOperations } from "../plugins/io.rabiroute.manager.core/src/manager/lanAgentTerminalRoutes.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { nativeHttpTestFetch } from "./nativeHttpTestClient.js";

test("registered terminal GET and POST lists preserve sessions beyond the hot history threshold", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-terminal-list-contract-"));
  const registry = new LanAgentRegistry({ statePath: path.join(root, "registry.json") });
  const sessions = Array.from({ length: 70 }, () => ({ terminalId: randomUUID(), shell: "cmd", cwd: root,
    state: "exited", createdAt: new Date().toISOString(), nextInputSequence: 1, exitCode: 0 }));
  t.mock.method(registry.terminals, "execute", async (instanceId: string, body: Record<string, unknown>) => {
    assert.equal(instanceId, "fixture-node"); assert.deepEqual(body, { action: "list" });
    return { shells: ["cmd"], sessions };
  });
  const routes = new ManagerPluginRouteRegistry();
  const registration = routes.registerOperations("fixture-terminal-list", createLanAgentTerminalOperations({ registry,
    isManagementRequestAuthorized: () => false }));
  const server = http.createServer((request, response) => {
    markAuthenticatedConnectionRequest(request);
    if (!routes.handle(request, new URL(request.url!, "http://fixture.invalid"), response)) response.writeHead(404).end();
  });
  t.after(async () => {
    server.closeAllConnections(); await registration.dispose(); registry.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/lan-agent/instances/fixture-node/terminals`;
  for (const method of ["GET", "POST"]) {
    const response = await nativeHttpTestFetch(url, { method, ...(method === "POST" ? {
      headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "list" }) } : {}) });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.code, 0); assert.deepEqual(result.data.sessions, sessions);
  }
});
