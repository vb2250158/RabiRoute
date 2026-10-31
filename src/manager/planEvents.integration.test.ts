import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { RoleStorageApplication } from "./roleStorageApplication.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { readPlanStoragePackage } from "../planStorageRepository.js";
import { createManagerEventOperationDefinition, closeManagerEventClients } from "./controlPlaneRoutes.js";

test("committed plans notify SSE subscribers and closed subscribers release the stream", { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-plan-events-"));
  const roleDir = path.join(root, "EventRole");
  fs.mkdirSync(roleDir);
  const identity = { applicationGenerationId: "event-test-generation", managerInstanceId: "event-test-manager" };
  const application = new RoleStorageApplication({ rolesRoot: root, ...identity, currentIdentity: () => identity });
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("event-test", [createManagerEventOperationDefinition()]);
  const server = http.createServer((request, response) => {
    if (!registry.handle(request, new URL(request.url || "/", "http://localhost"), response)) response.writeHead(404).end();
  });
  const controller = new AbortController();
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/events`, { signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    async function nextEvent(type: string): Promise<string> {
      while (true) {
        const boundary = pending.indexOf("\n\n");
        if (boundary >= 0) {
          const frame = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          if (frame.startsWith(`event: ${type}\n`)) return frame;
          continue; // SSE comments/keepalives are not business events.
        }
        const chunk = await reader.read();
        assert.equal(chunk.done, false, `Stream ended before ${type}`);
        pending += decoder.decode(chunk.value, { stream: true });
      }
    }
    assert.match(await nextEvent("ready"), /event: ready/);
    await application.commands.createPlan("EventRole", { id: "event-plan", title: "事件测试", focus: "测试", status: "分析中", keywords: ["测试"],
      currentStepId: "verify", steps: [{ id: "verify", title: "验证事件" }] });
    const message = await nextEvent("plan_changed");
    assert.match(message, /event: plan_changed/);
    assert.match(message, /"roleId":"EventRole","planId":"event-plan"/);
    assert.deepEqual(JSON.parse(message.split("\ndata: ")[1]!), { roleId: "EventRole", planId: "event-plan" });
    assert.ok(readPlanStoragePackage(roleDir, "event-plan", "active"));
    const before = await application.queries.plan("EventRole", "event-plan");
    assert.ok(before);
    await application.commands.updatePlan("EventRole", "event-plan", { status: "执行中" }, {
      expectedRevision: before.revision, idempotencyKey: "event-status-update"
    });
    assert.match(await nextEvent("plan_changed"), /event: plan_changed/);
    assert.equal((await application.queries.plan("EventRole", "event-plan"))?.plan.status, "执行中");
    closeManagerEventClients();
    assert.equal((await reader.read()).done, true);
    t.diagnostic("SSE create/update and stream close verified");
  } finally {
    controller.abort();
    closeManagerEventClients();
    await registration.dispose();
    await new Promise<void>(resolve => server.close(() => resolve()));
    t.diagnostic("HTTP server closed; waiting for storage application stop");
    await application.stop();
    t.diagnostic("Storage application stop completed");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
