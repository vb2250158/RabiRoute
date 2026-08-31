import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { handleNapcatControlApi, type NapcatControlRoutesContext } from "./napcatControlRoutes.js";

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("NapCat login control routes are POST-only, no-store, and keep actions behind the Manager context", async () => {
  const actions: unknown[] = [];
  const readJsonBody = async <T>(request: http.IncomingMessage): Promise<T> => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    return JSON.parse(raw || "{}") as T;
  };
  const jsonResponse = (response: http.ServerResponse, statusCode: number, body: unknown): void => {
    response.statusCode = statusCode;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify(body));
  };
  const context: NapcatControlRoutesContext = {
    readJsonBody,
    jsonResponse,
    repairAll: async () => ({ ok: true }),
    ensureReady: async () => ({ ok: true }),
    health: async () => ({ ok: true }),
    loginPanel: async (request) => ({ ok: true, request, credential: undefined }),
    loginAction: async (request) => {
      actions.push(request);
      return { ok: true, action: request.action };
    },
    configureOneBot: async () => ({ ok: true }),
    add: async () => ({ ok: true }),
    launch: async () => ({ ok: true }),
    restart: async () => ({ ok: true }),
    remove: async () => ({ ok: true })
  };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (!handleNapcatControlApi(request, url, response, context)) jsonResponse(response, 404, { ok: false });
  });
  const port = await listen(server);
  try {
    const panel = await fetch(`http://127.0.0.1:${port}/api/message/napcat-login-panel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gatewayId: "route", instanceId: "bot" })
    });
    assert.equal(panel.status, 200);
    assert.equal(panel.headers.get("cache-control"), "no-store");

    const action = await fetch(`http://127.0.0.1:${port}/api/message/napcat-login-action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gatewayId: "route", instanceId: "bot", action: "refresh-qr" })
    });
    assert.equal(action.status, 200);
    assert.equal(action.headers.get("cache-control"), "no-store");
    assert.deepEqual(actions, [{ gatewayId: "route", instanceId: "bot", action: "refresh-qr" }]);

    const get = await fetch(`http://127.0.0.1:${port}/api/message/napcat-login-panel`);
    assert.equal(get.status, 404);
  } finally {
    await close(server);
  }
});
