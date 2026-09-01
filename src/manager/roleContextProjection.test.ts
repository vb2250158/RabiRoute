import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import type { RoleKnowledgeSnapshot } from "../roleKnowledge.js";
import {
  fetchRoleContextProjection,
  handleRoleContextProjectionRequest,
  type RoleContextProjectionRouteContext
} from "./roleContextProjection.js";

function projection(roleId: string): RoleKnowledgeSnapshot {
  const roleDir = `C:/fixture/roles/${roleId}`;
  return {
    roleDir,
    plansDir: `${roleDir}/plans`,
    memoryDir: `${roleDir}/memory`,
    agentInterfaceDocPath: "docs/rabi-agent-interfaces.md",
    activePlans: [],
    activeSkills: [],
    recentMemories: [],
    matchedItems: [],
    matchedSkills: [],
    requiredReadItems: [],
    contextInjection: { mode: "focused", requiredReadLimit: 3, matchedItemLimit: 3, personaMaxChars: 1600 }
  };
}

function readJsonBody<T>(request: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T); }
      catch (error) { reject(error); }
    });
    request.on("error", reject);
  });
}

function jsonResponse(response: http.ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function withServer(
  patch: Partial<RoleContextProjectionRouteContext>,
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const context: RoleContextProjectionRouteContext = {
    identity: { applicationGenerationId: "generation-1", managerInstanceId: "manager-1" },
    isLoopback: () => true,
    verifyCapability: (routeId, roleId, capability) =>
      routeId === "gateway-1" && roleId === "Rabi" && capability === "capability-1",
    readJsonBody,
    resolve: body => projection(body.roleId),
    requestRefresh: () => undefined,
    jsonResponse,
    ...patch
  };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    if (!handleRoleContextProjectionRequest(request, url, response, context)) jsonResponse(response, 404, {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

const request = (managerBaseUrl: string) => ({
  managerBaseUrl,
  routeId: "gateway-1",
  roleId: "Rabi",
  capability: "capability-1",
  applicationGenerationId: "generation-1",
  managerInstanceId: "manager-1"
});

test("role context projection is fenced by route capability and exact Manager identity", async () => {
  await withServer({}, async (managerBaseUrl) => {
    const result = await fetchRoleContextProjection(request(managerBaseUrl));
    assert.equal(result.roleDir, "C:/fixture/roles/Rabi");
    await assert.rejects(
      fetchRoleContextProjection({ ...request(managerBaseUrl), managerInstanceId: "stale-manager" }),
      (error: unknown) => error instanceof Error && error.message === "Manager generation changed."
    );
  });
});

test("cold role context returns retryable 503 without a storage fallback", async () => {
  let refreshes = 0;
  await withServer({ resolve: () => undefined, requestRefresh: () => { refreshes += 1; } }, async (managerBaseUrl) => {
    await assert.rejects(
      fetchRoleContextProjection(request(managerBaseUrl)),
      (error: unknown) => error instanceof Error && error.message === "Role context is warming; retry shortly."
    );
  });
  assert.equal(refreshes, 1);
});
