import assert from "node:assert/strict";
import type http from "node:http";
import test from "node:test";
import { createAgentProviderControlRouteHandler } from "./agentProviderControlRoutes.js";

type RecordedResponse = {
  statusCode: number;
  body: unknown;
};

function request(method: string): http.IncomingMessage {
  return { method } as http.IncomingMessage;
}

const response = {} as http.ServerResponse;

async function readJsonBody<T>(): Promise<T> {
  return { url: "http://127.0.0.1", appId: "app-1" } as T;
}

test("agent provider handlers register every asynchronous response chain", async () => {
  const trackedOperations: Promise<unknown>[] = [];
  const responses: RecordedResponse[] = [];
  const trackOperation = <T>(operation: Promise<T>): Promise<T> => {
    trackedOperations.push(operation);
    return operation;
  };
  const jsonResponse = (_response: http.ServerResponse, statusCode: number, body: unknown): void => {
    responses.push({ statusCode, body });
  };

  const copilot = createAgentProviderControlRouteHandler("copilot", {
    jsonResponse,
    installCopilot: async () => ({ stdout: "installed", stderr: "" }),
    startCopilotLogin: async () => ({ kind: "completed" }),
    getCopilotStatus: async () => ({ installed: true }),
    publishEvent: () => undefined
  }, trackOperation);
  assert.equal(copilot(request("POST"), new URL("http://localhost/api/agent/copilot-install"), response), true);
  assert.equal(copilot(request("POST"), new URL("http://localhost/api/agent/copilot-login"), response), true);
  assert.equal(copilot(request("GET"), new URL("http://localhost/api/agent/copilot-status"), response), true);

  const astrbot = createAgentProviderControlRouteHandler("astrbot", {
    readJsonBody,
    jsonResponse,
    testAstrbotLogin: async () => ({ ok: true }),
    deployAstrbotAdapter: async () => ({ status: 200, body: { ok: true } })
  }, trackOperation);
  assert.equal(astrbot(request("POST"), new URL("http://localhost/api/agent/astrbot-login-test"), response), true);
  assert.equal(astrbot(request("POST"), new URL("http://localhost/api/deploy-astrbot-adapter"), response), true);

  const marvis = createAgentProviderControlRouteHandler("marvis", {
    readJsonBody,
    jsonResponse,
    openMarvis: body => ({ ok: true, body })
  }, trackOperation);
  assert.equal(marvis(request("POST"), new URL("http://localhost/api/agent/marvis-open"), response), true);

  assert.equal(trackedOperations.length, 6);
  assert.deepEqual(
    (await Promise.allSettled(trackedOperations)).map((result) => result.status),
    ["fulfilled", "fulfilled", "fulfilled", "fulfilled", "fulfilled", "fulfilled"]
  );
  assert.equal(responses.length, 6);
});
