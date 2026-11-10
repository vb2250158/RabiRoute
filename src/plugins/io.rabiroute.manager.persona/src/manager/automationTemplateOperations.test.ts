import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createAutomationTemplateOperations } from "./automationTemplateOperations.js";
import { ManagerPluginRouteRegistry } from "../../../../manager/managerPluginRouteRegistry.js";
import { markAuthenticatedConnectionRequest } from "../../../../manager/connectionRequestAccess.js";

test("template HTTP catalog pages summaries, reads one body and isolates bad plugin metadata", async t => {
  let templates: readonly unknown[] = [null, { id: "io.example.invalid-target", version: "1.0.0", title: "Invalid target", action: { type: "deliver_agent", message: "Bad target", target: "bad-native-target" } }, { id: "io.example.review", version: "1.0.0", title: "Custom review", description: "Example plugin", triggerType: "schedule", action: { type: "deliver_agent", message: "Full private instructions" } }];
  const registry = new ManagerPluginRouteRegistry(), registration = registry.registerOperations("templates", createAutomationTemplateOperations({ readAutomationTemplates: () => templates }));
  const server = http.createServer((request, response) => { markAuthenticatedConnectionRequest(request); if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await registration.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const get = async (suffix = "") => { const response = await fetch(base + "/api/automation/templates" + suffix); return { status: response.status, body: await response.json() }; };
  const page = await get("?limit=2"); assert.equal(page.status, 200); assert.equal(page.body.data.total, 7); assert.equal(page.body.data.items.length, 2);
  assert.equal(page.body.data.warnings.length, 2); assert.equal("action" in page.body.data.items[0], false); assert.ok(page.body.data.nextCursor);
  const second = await get("?limit=2&cursor=" + encodeURIComponent(page.body.data.nextCursor)); assert.equal(second.status, 200); assert.notEqual(second.body.data.items[0].id, page.body.data.items[0].id);
  const found = await get("?query=Custom"); assert.equal(found.body.data.items.length, 1); assert.equal(found.body.data.items[0].id, "io.example.review");
  const detail = await get("/io.example.review"); assert.equal(detail.status, 200); assert.equal(detail.body.data.template.action.message, "Full private instructions");
  templates = [...templates];
  templates = [...templates, { id: "io.example.another", version: "1.0.0", title: "Another", description: "Another plugin", triggerType: "message", action: { type: "deliver_agent", message: "Another" } }];
  assert.equal((await get("?limit=2&cursor=" + encodeURIComponent(page.body.data.nextCursor))).status, 409);
  assert.equal((await get("/missing")).status, 404);
});
