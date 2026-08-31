import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { listenManagerEndpoint } from "../managerEndpointPolicy.js";
import type { LanAgentRegistry } from "./lanAgentRegistry.js";
import type { LanAgentReleaseStore } from "./lanAgentReleaseStore.js";
import { handleLanAgentApi } from "./lanAgentRoutes.js";
import { webguiRequestToken, webguiTokenMatches } from "./webguiLanAccess.js";

const PLACEHOLDER_REQUEST_VALUE = "test-only-placeholder-lan-management";

async function readJsonBody<T>(request: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as T;
}

function jsonResponse(response: http.ServerResponse, statusCode: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.byteLength)
  });
  response.end(payload);
}

async function startServer() {
  let updateRequests = 0;
  const registry = {
    listNodes: () => [{ nodeId: "node-a", connected: true }],
    listTasks: () => [],
    requestUpdate: (nodeId: string, version: string) => {
      updateRequests += 1;
      return { nodeId, targetVersion: version, updateState: "requested" };
    },
    assignTask: () => { throw new Error("not used"); }
  } as unknown as LanAgentRegistry;
  const releases = {
    manifest: () => ({ version: "0.1.0", publicKeySha256: "a".repeat(64) })
  } as unknown as LanAgentReleaseStore;
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (!handleLanAgentApi(request, requestUrl, response, {
      readJsonBody,
      jsonResponse,
      isReleaseRequestAuthorized: () => false,
      isManagementRequestAuthorized: (candidate, candidateUrl) => (
        webguiTokenMatches(webguiRequestToken(candidate, candidateUrl), PLACEHOLDER_REQUEST_VALUE)
      ),
      registry,
      releases
    })) response.writeHead(404).end();
  });
  const endpoint = await listenManagerEndpoint({
    server,
    host: "127.0.0.1",
    policy: { mode: "auto" }
  });
  return {
    baseUrl: endpoint.baseUrl,
    updateRequests: () => updateRequests,
    close: () => new Promise<void>(resolve => server.close(() => resolve()))
  };
}

test("LAN Agent management rejects unauthenticated loopback reads and writes", async () => {
  const app = await startServer();
  try {
    const nodes = await fetch(`${app.baseUrl}/api/lan-agent/nodes`);
    assert.equal(nodes.status, 401);
    assert.equal((await nodes.json() as { error?: unknown }).error, "LAN_AGENT_MANAGEMENT_AUTH_REQUIRED");

    const update = await fetch(`${app.baseUrl}/api/lan-agent/nodes/node-a/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: "0.2.0" })
    });
    assert.equal(update.status, 401);
    assert.equal(app.updateRequests(), 0);
  } finally {
    await app.close();
  }
});

test("LAN Agent management accepts the explicit WebGUI token", async () => {
  const app = await startServer();
  try {
    const nodes = await fetch(`${app.baseUrl}/api/lan-agent/nodes`, {
      headers: { "x-rabiroute-webgui-token": PLACEHOLDER_REQUEST_VALUE }
    });
    assert.equal(nodes.status, 200);
    assert.deepEqual((await nodes.json() as { nodes?: unknown }).nodes, [{ nodeId: "node-a", connected: true }]);

    const update = await fetch(`${app.baseUrl}/api/lan-agent/nodes/node-a/update`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-rabiroute-webgui-token": PLACEHOLDER_REQUEST_VALUE
      },
      body: JSON.stringify({ version: "0.2.0" })
    });
    assert.equal(update.status, 202);
    assert.equal(app.updateRequests(), 1);
  } finally {
    await app.close();
  }
});
