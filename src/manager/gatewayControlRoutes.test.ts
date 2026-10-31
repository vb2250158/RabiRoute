import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import {
  type GatewayControlRoutesContext,
  type GatewayPayloadOptions,
  type GatewayWeixinLoginTarget
} from "./gatewayControlRoutes.js";

import { createGatewayControlOperations } from "./gatewayControlOperations.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { registerLanAgentBodyGuard, assertLanAgentBodyAuthority } from "./lanAgentBodyAuthority.js";

type RecordedCall = {
  name: string;
  args: unknown[];
};

function createFixture() {
  const calls: RecordedCall[] = [];
  const failures = new Map<string, Error>();
  const weixinTargets = new Map<string, GatewayWeixinLoginTarget>();
  let manualAlreadyRunning = false;

  function record(name: string, ...args: unknown[]): void {
    calls.push({ name, args });
    const failure = failures.get(name);
    if (failure) throw failure;
  }

  const runtimeStatuses = [{ id: "route-a", status: "running" }];
  const context: GatewayControlRoutesContext = {
    gatewayPayload(options?: GatewayPayloadOptions) {
      record("gatewayPayload", options);
      return { code: 0, data: { options: options ?? null, marker: "gateways" } };
    },
    async writeConfig(config, expectedContentHash, operationId) {
      record("writeConfig", config, expectedContentHash, operationId);
      return config;
    },
    async writeGatewayConfig(id, definition, hash, operationId) { record("writeGatewayConfig", id, definition, hash, operationId); },
    async resolveRouteMutation(operationId) { record("resolveRouteMutation", operationId); return { state: "committed" }; },
    async loadRuntimes() {
      record("loadRuntimes");
    },
    syncRunningGateways() {
      record("syncRunningGateways");
    },
    runtimeStatuses() {
      record("runtimeStatuses");
      return runtimeStatuses;
    },
    routeCatalogVersion() {
      return {
        contentHash: "a".repeat(64),
        routeConfigHash: "a".repeat(64),
        presentationHash: "b".repeat(64),
        revision: 7
      };
    },
    networkOptionsPayload() {
      record("networkOptionsPayload");
      return { code: 0, data: { localAddresses: [] } };
    },
    startGateway(id) {
      record("startGateway", id);
    },
    stopGateway(id) {
      record("stopGateway", id);
    },
    restartGateway(id) {
      record("restartGateway", id);
    },
    async removeGatewayConfig(id, expectedContentHash, operationId) {
      record("removeGatewayConfig", id, expectedContentHash, operationId);
    },
    weixinLoginTarget(id) {
      record("weixinLoginTarget", id);
      return weixinTargets.get(id);
    },
    requestWeixinLogin(dataDir) {
      record("requestWeixinLogin", dataDir);
    },
    triggerManualRule(id, body) {
      record("triggerManualRule", id, body);
      return { accepted: true, alreadyRunning: manualAlreadyRunning };
    },
    async testAgentDelivery(id, body) {
      record("testAgentDelivery", id, body);
      return {
        deliveryId: "12345678-1234-4234-8234-123456789abc",
        gatewayId: id,
        agentAdapterType: body.agentAdapterType ?? "codex",
        status: "delivered",
        completedAt: "2026-08-28T00:00:00.000Z"
      };
    },
    listDeliveryReplayAttempts(id, limit, status) {
      record("listDeliveryReplayAttempts", id, limit, status);
      return { gatewayId: id, attempts: [{ attemptId: "attempt-1" }] };
    },
    async replayDelivery(id, body) {
      record("replayDelivery", id, body);
    },

  };

  return {
    calls,
    context,
    failures,
    weixinTargets,
    setManualAlreadyRunning(value: boolean) {
      manualAlreadyRunning = value;
    }
  };
}

async function startServer(context: GatewayControlRoutesContext) {
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("gateway-runtime-test", createGatewayControlOperations(context));
  const server = http.createServer((request, response) => {
    markAuthenticatedConnectionRequest(request);
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (!registry.handle(request, requestUrl, response)) {
      response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ fallback: true }));
    }
  });
  let address: AddressInfo;
  do {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    server.removeAllListeners("error");
    address = server.address() as AddressInfo;
    if (address.port > 10_080) break;
    // Fetch rejects several historical service ports even when a local test server owns them.
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } while (true);
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    registry, registration,
    close: async () => { await registration.dispose(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  };
}

async function json(response: Response): Promise<Record<string, any>> {
  const body = await response.json() as Record<string, any>;
  if (body.errorMessages !== undefined) {
    assert.equal(typeof body.reason, "string"); assert.equal(typeof body.errorMessages.en, "string"); assert.equal(typeof body.errorMessages["zh-CN"], "string");
    delete body.reason; delete body.errorMessages;
  }
  return body;
}

test("scoped save reports persistence separately from activation and supports recovery lookup", async () => {
  const fixture = createFixture();
  const server = await startServer(fixture.context);
  try {
    fixture.failures.set("syncRunningGateways", new Error("activation unavailable"));
    const response = await fetch(`${server.baseUrl}/gateways/route-a/config`, {
      method: "PUT", headers: { "content-type": "application/json", "idempotency-key": "test:scoped", "if-match": `"${"a".repeat(64)}"` },
      body: JSON.stringify({ id: "route-a", configName: "route-a", enabled: false })
    });
    const body = await json(response);
    assert.equal(response.status, 200);
    assert.equal(body.receipt.state, "committed");
    assert.equal(body.activation.state, "failed");
    assert.equal(fixture.calls.filter(call => call.name === "writeConfig").length, 0);
    assert.equal(fixture.calls.filter(call => call.name === "writeGatewayConfig").length, 1);
    const recovered = await json(await fetch(`${server.baseUrl}/gateways/mutations/test%3Ascoped`));
    assert.equal(recovered.receipt.state, "committed");
    assert.equal(recovered.receipt.operationId, "test:scoped");
  } finally { await server.close(); }
});

async function post(
  baseUrl: string,
  pathname: string,
  body?: unknown,
  accept?: string,
  idempotencyKey = "gateway-test-operation",
  expectedContentHash = "a".repeat(64)
): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(accept ? { accept } : {}),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      ...(expectedContentHash ? { "if-match": expectedContentHash } : {})
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    redirect: "manual"
  });
}

test("GET /gateways preserves diagnostic and config query semantics", async () => {
  const fixture = createFixture();
  const app = await startServer(fixture.context);
  try {
    const full = await fetch(`${app.baseUrl}/gateways`);
    assert.equal(full.status, 200);
    assert.deepEqual((await json(full)).data.options, {
      includeDiagnostics: true,
      includeConfigDefinitions: true
    });

    const summary = await fetch(`${app.baseUrl}/gateways?summary=1`);
    assert.equal(summary.status, 200);
    assert.deepEqual((await json(summary)).data.options, {
      includeDiagnostics: false,
      includeConfigDefinitions: false
    });

    const summaryWithConfig = await fetch(`${app.baseUrl}/gateways?summary=1&includeConfig=1`);
    assert.equal(summaryWithConfig.status, 200);
    assert.deepEqual((await json(summaryWithConfig)).data.options, {
      includeDiagnostics: false,
      includeConfigDefinitions: true
    });
  } finally {
    await app.close();
  }
});

test("POST /gateways awaits the committed config snapshot and keeps 400 errors", async () => {
  const fixture = createFixture();
  const app = await startServer(fixture.context);
  try {
    const response = await post(app.baseUrl, "/gateways", { gateways: [] });
    assert.equal(response.status, 200);
    const responseBody = await json(response);
    assert.equal(responseBody.data.marker, "gateways");
    assert.deepEqual(responseBody.receipt, {
      state: "committed",
      operationId: "gateway-test-operation",
      routeConfigHash: "a".repeat(64)
    });
    assert.deepEqual(
      fixture.calls.map((call) => call.name),
      ["writeConfig", "syncRunningGateways", "gatewayPayload"]
    );
    assert.deepEqual(fixture.calls[0].args.slice(1), ["a".repeat(64), "gateway-test-operation"]);

    const invalid = await post(app.baseUrl, "/gateways", "{");
    assert.equal(invalid.status, 400);
    assert.equal((await json(invalid)).code, -1);
  } finally {
    await app.close();
  }
});

test("route mutations require a valid upstream Idempotency-Key and never invent one", async () => {
  const fixture = createFixture();
  const app = await startServer(fixture.context);
  try {
    const missing = await post(app.baseUrl, "/gateways", { gateways: [] }, undefined, "");
    assert.equal(missing.status, 400);
    assert.deepEqual(await json(missing), {
      code: -1,
      errorCode: "idempotency_key_required",
      message: "Idempotency-Key is required for route catalog mutations."
    });
    const invalid = await post(app.baseUrl, "/gateways/route-a/delete", undefined, undefined, "bad key");
    assert.equal(invalid.status, 400);
    assert.deepEqual(await json(invalid), {
      code: -1,
      errorCode: "idempotency_key_invalid",
      message: "Idempotency-Key is invalid for a route catalog mutation."
    });
    const missingRevision = await post(
      app.baseUrl,
      "/gateways",
      { gateways: [] },
      undefined,
      "gateway-test-operation",
      ""
    );
    assert.equal(missingRevision.status, 400);
    assert.equal((await json(missingRevision)).errorCode, "route_catalog_revision_required");
    assert.deepEqual(fixture.calls, []);
  } finally {
    await app.close();
  }
});

test("stale route catalog mutations return HTTP 412", async () => {
  const fixture = createFixture();
  fixture.failures.set("writeConfig", Object.assign(
    new Error("private child detail"),
    { code: "ROUTE_CATALOG_REVISION_CONFLICT" }
  ));
  const app = await startServer(fixture.context);
  try {
    const response = await post(app.baseUrl, "/gateways", { gateways: [] });
    assert.equal(response.status, 412);
    assert.deepEqual(await json(response), {
      code: -1,
      errorCode: "route_catalog_conflict",
      message: "Route catalog changed; refresh and retry this update."
    });
  } finally {
    await app.close();
  }
});

test("route mutation failures expose stable codes without child diagnostics", async () => {
  const fixture = createFixture();
  fixture.failures.set("writeConfig", Object.assign(
    new Error("child diagnostics=C:\\private\\roles"),
    { code: "ROUTE_CATALOG_TRANSACTION_FAILED" }
  ));
  const app = await startServer(fixture.context);
  try {
    const response = await post(app.baseUrl, "/gateways", { gateways: [] });
    assert.equal(response.status, 500);
    assert.deepEqual(await json(response), {
      code: -1,
      errorCode: "route_catalog_transaction_failed",
      message: "Route catalog update failed."
    });
  } finally {
    await app.close();
  }
});

test("POST /gateways fails closed without publishing uncommitted memory or private diagnostics", async () => {
  const fixture = createFixture();
  fixture.failures.set("writeConfig", Object.assign(
    new Error("Route catalog update is temporarily unavailable."),
    {
      statusCode: 503,
      code: "route_catalog_unavailable",
      cause: new Error("private \\\\nas\\route path")
    }
  ));
  const app = await startServer(fixture.context);
  try {
    const response = await post(app.baseUrl, "/gateways", { gateways: [] });
    const body = await json(response);
    assert.equal(response.status, 503);
    assert.deepEqual(body, {
      code: -1,
      errorCode: "route_catalog_unavailable",
      message: "Route catalog update is temporarily unavailable."
    });
    assert.equal(JSON.stringify(body).includes("nas"), false);
    assert.deepEqual(fixture.calls.map(call => call.name), ["writeConfig"]);
  } finally {
    await app.close();
  }
});

test("Gateway lifecycle actions keep success, delete, and error responses", async () => {
  const fixture = createFixture();
  const app = await startServer(fixture.context);
  try {
    for (const action of ["start", "stop", "restart"] as const) {
      const response = await post(app.baseUrl, `/gateways/route%20a/${action}`);
      assert.equal(response.status, 200);
      assert.deepEqual(await json(response), {
        code: 0,
        message: `requested ${action}`,
        data: [{ id: "route-a", status: "running" }]
      });
    }

    const deleted = await post(app.baseUrl, "/gateways/route-a/delete");
    assert.equal(deleted.status, 200);
    const deletedBody = await json(deleted);
    assert.equal(deletedBody.data.marker, "gateways");
    assert.equal(deletedBody.receipt.operationId, "gateway-test-operation");
    assert.equal(deletedBody.receipt.routeConfigHash, "a".repeat(64));
    assert.deepEqual(
      fixture.calls.slice(-3).map((call) => call.name),
      ["removeGatewayConfig", "syncRunningGateways", "gatewayPayload"]
    );
    const removeCall = fixture.calls.find(call => call.name === "removeGatewayConfig");
    assert.deepEqual(removeCall?.args, ["route-a", "a".repeat(64), "gateway-test-operation"]);

    fixture.failures.set("startGateway", new Error("start failed"));
    const failed = await post(app.baseUrl, "/gateways/route-a/start");
    assert.equal(failed.status, 400);
    assert.deepEqual(await json(failed), { code: -1, message: "start failed" });
  } finally {
    await app.close();
  }
});

test("Weixin login preserves missing, disabled, accepted, and failure responses", async () => {
  const fixture = createFixture();
  fixture.weixinTargets.set("disabled", { enabled: false, dataDir: "C:/routes/disabled" });
  fixture.weixinTargets.set("ready", { enabled: true, dataDir: "C:/routes/ready" });
  const app = await startServer(fixture.context);
  try {
    const missing = await post(app.baseUrl, "/gateways/missing/weixin-login");
    assert.equal(missing.status, 404);
    assert.deepEqual(await json(missing), { code: -1, message: "Gateway not found: missing" });

    const disabled = await post(app.baseUrl, "/gateways/disabled/weixin-login");
    assert.equal(disabled.status, 400);
    assert.equal((await json(disabled)).message, "该 Route 未启用个人微信消息端。");

    const accepted = await post(app.baseUrl, "/gateways/ready/weixin-login");
    assert.equal(accepted.status, 202);
    assert.deepEqual(await json(accepted), {
      code: 0,
      message: "已明确请求生成个人微信登录二维码；不会发送消息或修改账号配置。"
    });
    assert.equal(
      fixture.calls.some((call) => call.name === "requestWeixinLogin" && call.args[0] === "C:/routes/ready"),
      true
    );

    fixture.failures.set("requestWeixinLogin", new Error("login failed"));
    const failed = await post(app.baseUrl, "/gateways/ready/weixin-login");
    assert.equal(failed.status, 500);
    assert.deepEqual(await json(failed), { code: -1, message: "login failed" });
  } finally {
    await app.close();
  }
});

test("Agent delivery test returns the real target receipt", async () => {
  const fixture = createFixture();
  const app = await startServer(fixture.context);
  try {
    const delivered = await post(app.baseUrl, "/gateways/route-a/agent-delivery-test", {
      agentAdapterType: "dsh"
    });
    assert.equal(delivered.status, 200);
    assert.deepEqual(await json(delivered), {
      code: 0,
      message: "agent delivery test completed",
      data: {
        deliveryId: "12345678-1234-4234-8234-123456789abc",
        gatewayId: "route-a",
        agentAdapterType: "dsh",
        status: "delivered",
        completedAt: "2026-08-28T00:00:00.000Z"
      }
    });
    assert.deepEqual(fixture.calls.find(call => call.name === "testAgentDelivery")?.args, [
      "route-a",
      { agentAdapterType: "dsh" }
    ]);

    fixture.failures.set("testAgentDelivery", new Error("Desktop owner unavailable"));
    const failed = await post(app.baseUrl, "/gateways/route-a/agent-delivery-test", {
      agentAdapterType: "codex"
    });
    assert.equal(failed.status, 502);
    assert.deepEqual(await json(failed), { code: -1, message: "Desktop owner unavailable" });
  } finally {
    await app.close();
  }
});

test("Manual trigger keeps accepted, already-running, and parse failure responses", async () => {
  const fixture = createFixture();
  const app = await startServer(fixture.context);
  try {
    const accepted = await post(app.baseUrl, "/gateways/route-a/manual-trigger", {
      triggerId: "manual",
      message: "run"
    });
    assert.equal(accepted.status, 202);
    assert.deepEqual(await json(accepted), {
      code: 0,
      message: "manual trigger accepted",
      data: { accepted: true, alreadyRunning: false }
    });

    fixture.setManualAlreadyRunning(true);
    const running = await post(app.baseUrl, "/gateways/route-a/manual-trigger", {});
    assert.equal(running.status, 202);
    assert.equal((await json(running)).message, "manual trigger already running");

    const invalid = await post(app.baseUrl, "/gateways/route-a/manual-trigger", "{");
    assert.equal(invalid.status, 400);
    assert.equal((await json(invalid)).code, -1);
  } finally {
    await app.close();
  }
});

test("Delivery replay preserves list, replay, and error responses", async () => {
  const fixture = createFixture();
  const app = await startServer(fixture.context);
  try {
    const listed = await fetch(`${app.baseUrl}/gateways/route-a/delivery-replay?limit=25&status=failed`);
    assert.equal(listed.status, 200);
    assert.deepEqual(await json(listed), {
      code: 0,
      gatewayId: "route-a",
      attempts: [{ attemptId: "attempt-1" }]
    });
    assert.deepEqual(
      fixture.calls.find((call) => call.name === "listDeliveryReplayAttempts")?.args,
      ["route-a", 25, "failed"]
    );

    const replayed = await post(app.baseUrl, "/gateways/route-a/delivery-replay", { attemptId: "attempt-1" });
    assert.equal(replayed.status, 202);
    assert.deepEqual(await json(replayed), {
      code: 0,
      message: "delivery replay requested",
      data: [{ id: "route-a", status: "running" }]
    });

    const method = await fetch(`${app.baseUrl}/gateways/route-a/delivery-replay`, { method: "PUT" });
    assert.equal(method.status, 405);
    assert.deepEqual(await json(method), { code: -1, message: "Method not allowed" });

    fixture.failures.set("listDeliveryReplayAttempts", new Error("list failed"));
    const listFailed = await fetch(`${app.baseUrl}/gateways/route-a/delivery-replay`);
    assert.equal(listFailed.status, 400);
    assert.deepEqual(await json(listFailed), { code: -1, message: "list failed" });

    fixture.failures.set("replayDelivery", new Error("replay failed"));
    const replayFailed = await post(app.baseUrl, "/gateways/route-a/delivery-replay", { attemptId: "attempt-2" });
    assert.equal(replayFailed.status, 500);
    assert.deepEqual(await json(replayFailed), { code: -1, message: "replay failed" });
  } finally {
    await app.close();
  }
});

test("Network options and reload preserve JSON and redirect responses", async () => {
  const fixture = createFixture();
  const app = await startServer(fixture.context);
  try {
    const network = await fetch(`${app.baseUrl}/network-options`);
    assert.equal(network.status, 200);
    assert.deepEqual(await json(network), { code: 0, data: { localAddresses: [] } });

    const reloadJson = await post(app.baseUrl, "/reload", undefined, "application/json");
    assert.equal(reloadJson.status, 200);
    assert.deepEqual(await json(reloadJson), {
      ok: true,
      gateways: [{ id: "route-a", status: "running" }],
      routeCatalog: {
        contentHash: "a".repeat(64),
        routeConfigHash: "a".repeat(64),
        presentationHash: "b".repeat(64),
        revision: 7
      }
    });

    const reloadRedirect = await post(app.baseUrl, "/reload");
    assert.equal(reloadRedirect.status, 303);
    assert.equal(reloadRedirect.headers.get("location"), "/");

    assert.equal(fixture.calls.filter((call) => call.name === "loadRuntimes").length, 2);
    assert.equal(fixture.calls.filter((call) => call.name === "syncRunningGateways").length, 2);
  } finally {
    await app.close();
  }
});

test("Unrelated paths and unsupported top-level methods fall through", async () => {
  const fixture = createFixture();
  const app = await startServer(fixture.context);
  try {
    const unrelated = await fetch(`${app.baseUrl}/api/unrelated`);
    assert.equal(unrelated.status, 404);
    assert.deepEqual(await json(unrelated), { fallback: true });

    const getReload = await fetch(`${app.baseUrl}/reload`);
    assert.equal(getReload.status, 405);

    const putGateways = await fetch(`${app.baseUrl}/gateways`, { method: "PUT" });
    assert.equal(putGateways.status, 405);
  } finally {
    await app.close();
  }
});


test("one executable catalog registers the native gateway owners and retires all operations", async () => {
  const fixture = createFixture();
  const app = await startServer(fixture.context);
  try {
    assert.equal(app.registry.catalogSnapshot().operations.length, 15);
    await post(app.baseUrl, "/gateways", { gateways: [] });
    await post(app.baseUrl, "/gateways/route-a/manual-trigger", { triggerId: "manual" });
    await post(app.baseUrl, "/gateways/route-a/agent-delivery-test", { agentAdapterType: "codex" });
    await post(app.baseUrl, "/gateways/route-a/delivery-replay", { attemptId: "attempt-1" });
    await app.registration.dispose();
    assert.equal(app.registry.catalogSnapshot().operations.length, 0);
  } finally { await app.close(); }
});

async function enrolledFixture(t: test.TestContext, readOnly = false) {
  const fixture = createFixture(), root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-control-operation-"));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "empty-gateway-node");
  const registry = new ManagerPluginRouteRegistry(), unblock: Array<() => void> = [];
  let registration: ReturnType<typeof registry.registerOperations>, server: http.Server | undefined;
  t.after(async () => {
    for (const release of unblock) release(); await registration?.dispose();
    server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("gateway-control-operation-")); fs.rmSync(root, { recursive: true, force: true });
  });
  registration = registry.registerOperations("enrolled-gateway-fixture", createGatewayControlOperations(fixture.context, readOnly));
  server = http.createServer((request, response) => {
    if (evaluateLanAgentRequest(request, authority, true).kind !== "agent") { response.writeHead(401).end(); return; }
    markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
    registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority(new URL(request.url!, "http://fixture").pathname, body, undefined));
    if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const request = (url: string, method = "GET", body?: unknown, headers?: Record<string, string>, signal?: AbortSignal) => new Promise<Response>((resolve, reject) => {
    const outgoing = http.request(base + url, { method, signal, headers: { authorization: "Bearer " + credential.token, "content-type": "text/plain", ...headers } }, incoming => {
      const chunks: Buffer[] = []; incoming.on("data", chunk => chunks.push(Buffer.from(chunk))); incoming.on("error", reject);
      incoming.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode!, headers: incoming.headers as Record<string, string> })));
    }); outgoing.on("error", reject); outgoing.setTimeout(15000, () => outgoing.destroy(new Error("Owned gateway fixture timeout."))); outgoing.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
  });
  const hold = (key: "writeConfig" | "testAgentDelivery") => {
    const original = fixture.context[key].bind(fixture.context) as (...args: any[]) => Promise<unknown>;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; }); unblock.push(release);
    (fixture.context as any)[key] = async (...args: any[]) => { entered(); await gate; const result = await original(...args); if (key === "writeConfig") fs.writeFileSync(path.join(root, "committed.json"), JSON.stringify({ operationId: args[2], config: result })); return result; };
    return { started, release };
  };
  return { ...fixture, root, request, authority, credential, registry, registration, hold };
}

test("an enrolled empty Node calls native public gateway reads, lifecycle and scoped writes without another feature grant", async t => {
  const f = await enrolledFixture(t);
  assert.equal(f.registry.catalogSnapshot().operations.length, 15);
  assert.ok(f.registry.catalogSnapshot().operations.every(operation => operation.contract.exposure === "public"));
  assert.equal((await f.request("/gateways?summary=1&includeConfig=1")).status, 200);
  assert.equal((await f.request("/network-options")).status, 200);
  for (const action of ["start", "stop", "restart"]) assert.equal((await f.request("/gateways/route-a/" + action, "POST", "ignored native body")).status, 200);
  const response = await f.request("/gateways/route-a/config", "PUT", { id: "route-a", enabled: false }, { "idempotency-key": "native-scoped-key", "if-match": "a".repeat(64) });
  assert.equal(response.status, 200); assert.equal((await response.json()).receipt.operationId, "native-scoped-key");
  assert.deepEqual(f.calls.find(call => call.name === "writeGatewayConfig")?.args.slice(2), ["a".repeat(64), "native-scoped-key"]);
});

test("read-only mode and native Route preconditions reject before malformed write JSON or ignored native bodies", async t => {
  const readOnly = await enrolledFixture(t, true);
  for (const endpoint of ["/gateways", "/gateways/route-a/config", "/gateways/route-a/manual-trigger", "/gateways/route-a/delete", "/reload"]) {
    assert.equal((await readOnly.request(endpoint, endpoint.endsWith("config") ? "PUT" : "POST", "not-json")).status, 403);
  }
  assert.equal(readOnly.calls.length, 0); assert.equal((await readOnly.request("/gateways")).status, 200);
  const f = await enrolledFixture(t);
  for (const [endpoint, method] of [["/gateways", "POST"], ["/gateways/route-a/config", "PUT"], ["/gateways/route-a/delete", "POST"]]) {
    const response = await f.request(endpoint, method, "not-json", { "idempotency-key": "same-native-key", "if-match": 'W/"' + "a".repeat(64) + '"' });
    assert.equal(response.status, 400); assert.equal((await response.json()).errorCode, "route_catalog_revision_invalid");
  }
  assert.equal(f.calls.length, 0);
});

test("revocation after an accepted native write hides its result and preserves the original committed key", async t => {
  const f = await enrolledFixture(t), hold = f.hold("writeConfig");
  const pending = f.request("/gateways", "POST", { gateways: [] }, { "idempotency-key": "original-commit-key", "if-match": "a".repeat(64) });
  await hold.started; f.authority.setNodeEnabled(f.credential.nodeId, false, true); f.authority.setNodeEnabled(f.credential.nodeId, true, false); hold.release();
  const response = await pending; assert.equal(response.status, 403); const result = await response.json(); assert.equal(result.uncertain, true); assert.equal(result.receipt, undefined); assert.equal(result.data, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, "committed.json"), "utf8")), { operationId: "original-commit-key", config: { gateways: [] } });
  assert.equal(f.calls.filter(call => call.name === "writeConfig").length, 1);
});

test("retirement after HTTP disconnect joins a controlled native delivery test before releasing its operation lease", async t => {
  const f = await enrolledFixture(t), hold = f.hold("testAgentDelivery"), controller = new AbortController();
  const pending = f.request("/gateways/route-a/agent-delivery-test", "POST", { agentAdapterType: "codex" }, undefined, controller.signal).catch(() => undefined);
  await hold.started; controller.abort(); await pending;
  let retired = false; const retirement = f.registration.dispose().then(() => { retired = true; }); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(retired, false);
  hold.release(); await retirement; assert.equal(f.registry.catalogSnapshot().operations.length, 0); assert.equal(f.calls.filter(call => call.name === "testAgentDelivery").length, 1);
});
