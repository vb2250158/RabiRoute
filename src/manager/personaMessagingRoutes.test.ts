import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readRolePanelTimeline } from "../rolePanelTimeline.js";
import type { GatewayDefinition } from "../shared/gatewayConfigModel.js";
import type { GatewayRuntime } from "./runtimeRegistry.js";
import { PersonaCatalog } from "./personaCatalog.js";
import {
  handlePersonaMessagingApi,
  listPersonas,
  type PersonaMessagingRouteContext
} from "./personaMessagingRoutes.js";

function runtime(id: string, personaId: string, enabled = true): GatewayRuntime {
  const definition: GatewayDefinition = {
    id,
    name: `${personaId} Route`,
    enabled,
    gatewayPort: 9000,
    agentRoleId: personaId,
    agentAdapters: ["codex"]
  };
  return {
    definition,
    process: null,
    needsRestart: false,
    startedAt: null,
    stoppedAt: null,
    lastExit: null,
    log: []
  };
}

function persona(root: string, id: string, title: string): void {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "persona.md"), `# ${title}\n`, "utf8");
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Missing test port."));
      resolve(address.port);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

test("persona directory exposes user-facing names and enabled Route reachability", (t) => {
  const rolesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-personas-"));
  t.after(() => fs.rmSync(rolesRoot, { recursive: true, force: true }));
  persona(rolesRoot, "Rabi", "拉比");
  persona(rolesRoot, "Builder", "星海建造师");
  persona(rolesRoot, "Silent", "");

  const personas = listPersonas({
    rolesRoot,
    catalog: new PersonaCatalog(),
    runtimes: () => [runtime("rabi-main", "Rabi", false), runtime("builder-main", "Builder"), runtime("silent-main", "Silent")]
  });

  assert.deepEqual(personas.map(item => [item.personaId, item.name, item.addressable]), [
    ["Rabi", "拉比", false],
    ["Builder", "星海建造师", true],
    ["Silent", "Silent Route", true]
  ]);
  assert.equal(personas.find(item => item.personaId === "Builder")?.defaultRouteId, "builder-main");
});

test("persona message API authenticates the Route-bound sender and delivers to the target persona", async (t) => {
  const rolesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-message-"));
  t.after(() => fs.rmSync(rolesRoot, { recursive: true, force: true }));
  persona(rolesRoot, "Rabi", "拉比");
  persona(rolesRoot, "Builder", "星海建造师");
  const runtimes = [runtime("rabi-main", "Rabi"), runtime("builder-main", "Builder")];
  const deliveries: Array<{ routeId: string; replyContext: Record<string, unknown> }> = [];
  const context: PersonaMessagingRouteContext = {
    rootDir: rolesRoot,
    rolesRoot,
    catalog: new PersonaCatalog(),
    runtimes: () => runtimes,
    authorizeSource: (routeId, personaId, capability) => capability === `capability:${routeId}:${personaId}`,
    deliver: async (target, _messageId, _text, _attachments, replyContext) => {
      deliveries.push({ routeId: target.definition.id, replyContext });
    }
  };
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    if (!handlePersonaMessagingApi(request, requestUrl, response, context)) response.writeHead(404).end();
  });
  const port = await listen(server);
  t.after(() => close(server));

  const listResponse = await fetch(`http://127.0.0.1:${port}/api/personas?addressable=true`);
  assert.equal(listResponse.status, 200);
  const listPayload = await listResponse.json() as { personas: Array<{ personaId: string }> };
  assert.deepEqual(listPayload.personas.map(item => item.personaId).sort(), ["Builder", "Rabi"]);

  const response = await fetch(`http://127.0.0.1:${port}/api/personas/Builder/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      deliveryId: "persona-delivery-1",
      sourceRouteId: "rabi-main",
      sourceCapability: "capability:rabi-main:Rabi",
      conversationId: "persona-conversation-1",
      inReplyToMessageId: "source-message-1",
      hopCount: 2,
      text: "请检查今天的构建状态。"
    })
  });
  assert.equal(response.status, 202);
  const payload = await response.json() as Record<string, unknown>;
  assert.equal(payload.status, "delivered");
  assert.equal(payload.sourcePersonaId, "Rabi");
  assert.equal(payload.targetPersonaId, "Builder");
  assert.equal(payload.timelineRecorded, true);
  assert.equal(deliveries[0].routeId, "builder-main");
  assert.equal(deliveries[0].replyContext.crossPersona, true);
  assert.equal(deliveries[0].replyContext.sourcePersonaName, "拉比");
  assert.equal(deliveries[0].replyContext.personaConversationId, "persona-conversation-1");
  assert.equal(deliveries[0].replyContext.inReplyToPersonaMessageId, "source-message-1");
  assert.equal(deliveries[0].replyContext.personaMessageHopCount, 2);

  const timeline = readRolePanelTimeline(path.join(rolesRoot, "Builder"));
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].sender, "拉比");
  assert.equal(timeline[0].status, "sent");
  assert.equal(JSON.stringify(timeline).includes("sourceCapability"), false);
  assert.equal(JSON.stringify(timeline).includes("capability:rabi-main:Rabi"), false);
});

test("persona message deliveryId is durable and rejects changed retry payloads", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-message-idempotency-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const rolesRoot = path.join(rootDir, "roles");
  persona(rolesRoot, "Rabi", "拉比");
  persona(rolesRoot, "Builder", "星海建造师");
  let deliveryCount = 0;
  const context: PersonaMessagingRouteContext = {
    rootDir,
    rolesRoot,
    catalog: new PersonaCatalog(),
    runtimes: () => [runtime("rabi-main", "Rabi"), runtime("builder-main", "Builder")],
    authorizeSource: (routeId, personaId, capability) => capability === `capability:${routeId}:${personaId}`,
    deliver: async () => { deliveryCount += 1; }
  };
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    if (!handlePersonaMessagingApi(request, requestUrl, response, context)) response.writeHead(404).end();
  });
  const port = await listen(server);
  t.after(() => close(server));
  const post = (text: string) => fetch(`http://127.0.0.1:${port}/api/personas/Builder/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      deliveryId: "stable-persona-delivery",
      sourceRouteId: "rabi-main",
      sourceCapability: "capability:rabi-main:Rabi",
      text
    })
  });

  const first = await post("same payload");
  assert.equal(first.status, 202);
  const duplicate = await post("same payload");
  assert.equal(duplicate.status, 202);
  const duplicateBody = await duplicate.json() as { idempotency?: { duplicate?: boolean } };
  assert.equal(duplicateBody.idempotency?.duplicate, true);
  assert.equal(deliveryCount, 1);
  const receipt = await fetch(`http://127.0.0.1:${port}/api/personas/messages/receipts/stable-persona-delivery`);
  assert.equal(receipt.status, 200);
  const receiptBody = await receipt.json() as { receipt?: { state?: string } };
  assert.equal(receiptBody.receipt?.state, "completed");
  assert.equal(JSON.stringify(receiptBody).includes("sourceCapability"), false);
  assert.equal(JSON.stringify(receiptBody).includes("capability:rabi-main:Rabi"), false);
  assert.equal((await post("changed payload")).status, 409);
});

test("persona message API refuses disabled sources, self delivery, and ambiguous targets", async (t) => {
  const rolesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-message-guards-"));
  t.after(() => fs.rmSync(rolesRoot, { recursive: true, force: true }));
  persona(rolesRoot, "Rabi", "拉比");
  persona(rolesRoot, "Builder", "星海建造师");
  const runtimes = [
    runtime("rabi-disabled", "Rabi", false),
    runtime("rabi-main", "Rabi"),
    runtime("builder-a", "Builder"),
    runtime("builder-b", "Builder")
  ];
  const context: PersonaMessagingRouteContext = {
    rootDir: rolesRoot,
    rolesRoot,
    catalog: new PersonaCatalog(),
    runtimes: () => runtimes,
    authorizeSource: (routeId, personaId, capability) => capability === `capability:${routeId}:${personaId}`,
    deliver: async () => undefined
  };
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    if (!handlePersonaMessagingApi(request, requestUrl, response, context)) response.writeHead(404).end();
  });
  const port = await listen(server);
  t.after(() => close(server));

  const post = (target: string, body: Record<string, unknown>) => fetch(`http://127.0.0.1:${port}/api/personas/${target}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  assert.equal((await post("Builder", { deliveryId: "disabled", sourceRouteId: "rabi-disabled", sourceCapability: "capability:rabi-disabled:Rabi", text: "x" })).status, 409);
  assert.equal((await post("Builder", { deliveryId: "forged", sourceRouteId: "rabi-main", sourceCapability: "capability:builder-main:Builder", text: "x" })).status, 403);
  assert.equal((await post("Rabi", { deliveryId: "self", sourceRouteId: "rabi-main", sourceCapability: "capability:rabi-main:Rabi", text: "x" })).status, 409);
  assert.equal((await post("Builder", { deliveryId: "ambiguous", sourceRouteId: "rabi-main", sourceCapability: "capability:rabi-main:Rabi", text: "x" })).status, 409);
  assert.equal((await post("Builder", { deliveryId: "loop", sourceRouteId: "rabi-main", sourceCapability: "capability:rabi-main:Rabi", targetRouteId: "builder-b", hopCount: 9, text: "x" })).status, 409);
  assert.equal((await post("Builder", { deliveryId: "selected", sourceRouteId: "rabi-main", sourceCapability: "capability:rabi-main:Rabi", targetRouteId: "builder-b", text: "x" })).status, 202);
});

test("persona message API reports target handler failure without claiming delivery", async (t) => {
  const rolesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-message-failure-"));
  t.after(() => fs.rmSync(rolesRoot, { recursive: true, force: true }));
  persona(rolesRoot, "Rabi", "拉比");
  persona(rolesRoot, "Builder", "星海建造师");
  const context: PersonaMessagingRouteContext = {
    rootDir: rolesRoot,
    rolesRoot,
    catalog: new PersonaCatalog(),
    runtimes: () => [runtime("rabi-main", "Rabi"), runtime("builder-main", "Builder")],
    authorizeSource: (routeId, personaId, capability) => capability === `capability:${routeId}:${personaId}`,
    deliver: async () => { throw new Error("Desktop owner unavailable"); }
  };
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    if (!handlePersonaMessagingApi(request, requestUrl, response, context)) response.writeHead(404).end();
  });
  const port = await listen(server);
  t.after(() => close(server));

  const response = await fetch(`http://127.0.0.1:${port}/api/personas/Builder/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      deliveryId: "failed-delivery",
      sourceRouteId: "rabi-main",
      sourceCapability: "capability:rabi-main:Rabi",
      text: "失败路径"
    })
  });
  assert.equal(response.status, 502);
  const payload = await response.json() as Record<string, unknown>;
  assert.equal(payload.status, "failed");
  assert.match(String(payload.message), /Desktop owner unavailable/);
  const timeline = readRolePanelTimeline(path.join(rolesRoot, "Builder"));
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].status, "failed");
});
