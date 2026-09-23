import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleAgentThreadRequest } from "./agentThreads.js";

const sessionId = "session-00000000-0000-4000-8000-000000000001";

// Exercise the real driver, discovery, authentication and HTTP RPC paths.
// Every endpoint is an ephemeral fixture; no live Home, Route or credential is read.
test("DSH thread read/list discover the owner without a complete primary binding and preserve URL priority", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-threads-discovery-"));
  const keys = ["DSH_HOME", "DSH_WEB_URL", "RABI_DSH_ROUTE_CONFIG_PATH", "RABI_DSH_AUTH_FILE", "RABIROUTE_STATE_ROOT"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const servers: http.Server[] = [];
  t.after(async () => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    })));
    fs.rmSync(temp, { recursive: true, force: true });
  });
  process.env.DSH_HOME = path.join(temp, "home");
  delete process.env.DSH_WEB_URL;
  process.env.RABI_DSH_ROUTE_CONFIG_PATH = path.join(temp, "route.json");
  process.env.RABI_DSH_AUTH_FILE = path.join(temp, "auth.json");
  process.env.RABIROUTE_STATE_ROOT = path.join(temp, "state");
  fs.mkdirSync(path.join(process.env.DSH_HOME, "logs"), { recursive: true });

  const calls: string[] = [];
  async function owner(label: string) {
    const server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (request.method !== "POST" || request.url !== "/api/session/list" || request.headers.cookie) {
        response.writeHead(400).end();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      calls.push(label);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ rpcId: body.rpcId, result: { ok: true, value: { items: [{
        sessionId, cwd: temp, updatedAt: 1, running: false,
        projections: { values: { title: label } }
      }] } } }));
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return `http://127.0.0.1:${address.port}`;
  }
  const discovered = await owner("discovered");
  const primary = await owner("primary");
  const explicit = await owner("explicit");
  fs.writeFileSync(path.join(process.env.DSH_HOME, "logs", "web-host.stdout.log"), `dsh web: ${discovered}/\n`);
  fs.writeFileSync(process.env.RABI_DSH_AUTH_FILE, JSON.stringify({ endpoints: [] }));

  async function verify(expected: string, dshBaseUrl?: string) {
    const options = { allowedWorkspaces: [temp], ...(dshBaseUrl ? { dshBaseUrl } : {}) };
    const read = await handleAgentThreadRequest({ action: "read", agentAdapter: "dsh", threadId: sessionId }, options);
    assert.equal(read.statusCode, 200);
    assert.equal((read.data.thread as { id: string; title: string }).id, sessionId);
    assert.equal((read.data.thread as { title: string }).title, expected);
    const list = await handleAgentThreadRequest({ action: "list", agentAdapter: "dsh" }, options);
    assert.equal(list.statusCode, 200);
    assert.deepEqual((list.data.threads as Array<{ id: string; title: string }>).map(row => [row.id, row.title]), [[sessionId, expected]]);
  }

  await verify("discovered"); // No primary config.
  fs.writeFileSync(process.env.RABI_DSH_ROUTE_CONFIG_PATH, JSON.stringify({ dshBaseUrl: primary, dshCwd: temp }));
  await verify("discovered"); // A URL without a session ID is not a complete primary binding.
  await verify("explicit", ` ${explicit} `);
  fs.writeFileSync(process.env.RABI_DSH_ROUTE_CONFIG_PATH, JSON.stringify({ dshSessionId: sessionId, dshCwd: temp, dshBaseUrl: primary }));
  await verify("primary");
  await verify("explicit", explicit);
  assert.deepEqual(calls, ["discovered", "discovered", "discovered", "discovered", "explicit", "explicit", "primary", "primary", "explicit", "explicit"]);
});
