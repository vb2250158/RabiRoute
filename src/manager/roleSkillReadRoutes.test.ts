import assert from "node:assert/strict";
import http from "node:http";
import { Socket } from "node:net";
import fs from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { authorizeLanAgentRoleSkillRequest } from "./lanAgentRoleSkillAccess.js";
import { parseRoleKnowledgeResourceRoute } from "./roleKnowledgeRoute.js";
import { respondRoleSkillRead } from "./roleSkillReadRoutes.js";
import { managerReadHttpResponse } from "./managerReadHttpResponse.js";
import { ManagerReadWorkerError } from "./managerReadWorkerPool.js";
import { remoteAgentTargetKey } from "../shared/routeAgentTargets.js";

const principal = { kind: "agent", nodeId: "node-one", agentId: "agent-one" } as const;
const binding = { instanceId: principal.nodeId, agentId: principal.agentId };
const definitions = [{ persona: "persona-one", remoteAgentTargets: [{ ...binding, id: remoteAgentTargetKey(binding), provider: "codex" as const }] }];
const json = (response: http.ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};
async function serve(context: TestContext, listener: http.RequestListener) {
  const server = http.createServer(listener);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

test("real HTTP role Skill routes reject before reading and preserve aliases, list, detail and 404", async context => {
  let reads = 0;
  const completed: Promise<void>[] = [];
  const listenerCounts: Array<[number, number]> = [];
  const base = await serve(context, (request, response) => {
    const pathname = new URL(request.url!, "http://fixture.invalid").pathname;
    const access = authorizeLanAgentRoleSkillRequest(principal, request.method, pathname, definitions, definition => definition.persona);
    if (!access.allowed) { json(response, access.status, { code: -1, error: access.error }); return; }
    const route = parseRoleKnowledgeResourceRoute(pathname);
    assert.ok(route && route.resource === "skills");
    const previous = [request.listenerCount("aborted"), response.listenerCount("close")];
    completed.push(respondRoleSkillRead(request, response, route.roleId, route.itemId, {
      json,
      querySkills: async (_roleDir, skillId) => {
        reads++;
        if (skillId === "missing") return null;
        return skillId ? { id: skillId, content: "Public fixture" } : [{ id: "example" }];
      }
    }).then(() => {
      listenerCounts.push([request.listenerCount("aborted") - previous[0], response.listenerCount("close") - previous[1]]);
    }));
  });
  for (const prefix of ["/api/roles", "/roles"]) {
    for (const suffix of ["/skills", "/skills/example"]) {
      const response = await fetch(`${base}${prefix}/other-persona${suffix}`, { signal: AbortSignal.timeout(2000) });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error, "LAN_AGENT_PERSONA_NOT_CONFIGURED");
    }
  }
  assert.equal(reads, 0);
  for (const prefix of ["/api/roles", "/roles"]) {
    const listed = await fetch(`${base}${prefix}/persona-one/skills`, { signal: AbortSignal.timeout(2000) });
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json()).data, [{ id: "example" }]);
    const detail = await fetch(`${base}${prefix}/persona-one/skills/example`, { signal: AbortSignal.timeout(2000) });
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).data.id, "example");
    const missing = await fetch(`${base}${prefix}/persona-one/skills/missing`, { signal: AbortSignal.timeout(2000) });
    assert.equal(missing.status, 404);
    await missing.arrayBuffer();
  }
  await Promise.all(completed);
  assert.equal(reads, 6);
  assert.ok(listenerCounts.every(([request, response]) => request === 0 && response === 0));
});

test("reader unavailable is 503; Skill business failures stay 500 and history default stays 400", async context => {
  const base = await serve(context, (request, response) => {
    const code = request.url!.slice(1);
    const read = async () => {
      if (code === "business" || code === "history") throw new Error("Fixture read failed");
      throw new ManagerReadWorkerError("Fixture worker unavailable", code as "busy" | "timeout" | "termination_unconfirmed");
    };
    if (code === "history") {
      void managerReadHttpResponse(request, response, { read, json, respond: () => assert.fail("unexpected success") });
    } else {
      void respondRoleSkillRead(request, response, "persona-one", undefined, { json, querySkills: read });
    }
  });
  for (const [path, status] of [["busy", 503], ["timeout", 503], ["termination_unconfirmed", 503], ["business", 500], ["history", 400]] as const) {
    const response = await fetch(`${base}/${path}`, { signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, status);
    assert.equal((await response.json()).code, -1);
  }
});

test("real client disconnect aborts the reader and removes listeners without writing a response", async context => {
  let start!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  let writes = 0;
  let aborted = false;
  let listenerDelta: number[] = [];
  const base = await serve(context, (request, response) => {
    const previous = [request.listenerCount("aborted"), response.listenerCount("close")];
    void respondRoleSkillRead(request, response, "persona-one", undefined, {
      json: () => { writes++; },
      querySkills: (_roleDir, _skillId, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
        start();
      })
    }).finally(() => {
      listenerDelta = [request.listenerCount("aborted") - previous[0], response.listenerCount("close") - previous[1]];
      finish();
    });
  });
  const controller = new AbortController();
  const result = fetch(base, { signal: controller.signal });
  const rejected = assert.rejects(result);
  await started;
  controller.abort();
  await rejected;
  await finished;
  assert.equal(aborted, true);
  assert.equal(writes, 0);
  assert.deepEqual(listenerDelta, [0, 0]);
});

test("already aborted request or destroyed response never starts a read", async () => {
  for (const state of ["request-aborted", "response-destroyed"] as const) {
    const socket = new Socket();
    const request = new http.IncomingMessage(socket);
    const response = new http.ServerResponse(request);
    if (state === "request-aborted") request.aborted = true;
    else response.destroy();
    let reads = 0;
    let writes = 0;
    await managerReadHttpResponse(request, response, {
      read: async () => { reads++; }, json: () => { writes++; }, respond: () => { writes++; }
    });
    assert.equal(reads, 0);
    assert.equal(writes, 0);
    assert.equal(request.listenerCount("aborted"), 0);
    assert.equal(response.listenerCount("close"), 0);
    socket.destroy();
  }
});

test("Manager wires role guard before reads and moves list and detail to the interactive pool", async () => {
  const source = await fs.readFile(new URL("./controlPlaneRoutes.ts", import.meta.url), "utf8");
  assert.match(source, /if \(lanAgentAccess\.kind === "agent"\) \{\s*const skillAccess = authorizeLanAgentRoleSkillRequest\(/);
  assert.match(source, /if \(!skillAccess\.allowed\) \{\s*jsonResponse\(response, skillAccess\.status,[\s\S]*?return;/);
  const branch = source.slice(source.indexOf('if (request.method === "GET" && resource === "skills")'), source.indexOf('if (request.method === "GET" && resource === "memory" && !itemId)'));
  assert.match(branch, /respondRoleSkillRead\(request, response, roleDir, itemId/);
  assert.match(branch, /managerKnowledgePageWorkerPool\.run\(/);
  assert.doesNotMatch(branch, /managerCatalogWorkerPool/);
});
