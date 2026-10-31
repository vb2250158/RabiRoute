import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { createPersonaHealthOperations } from "./personaHealthOperations.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";

const applicationGenerationId = "application-generation-current";
const managerInstanceId = "manager-instance-current";
const observation = Object.freeze({
  sourceDeviceId: "wearable-fence-test",
  samples: [Object.freeze({
    id: "wearable-fence-sample-1",
    metric: "heart_rate",
    recordedAt: "2026-08-31T00:00:00.000Z",
    value: 72,
    unit: "bpm"
  })]
});

function postObservation(
  port: number,
  headers: Readonly<Record<string, string>>
): Promise<Readonly<{ statusCode: number; body: Record<string, unknown> }>> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/api/roles/YeYu/health/observations",
      headers: {
        ...headers,
        "content-type": "application/json; charset=utf-8"
      }
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        try {
          resolve({
            statusCode: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
    request.end(JSON.stringify(observation));
  });
}

test("wearable observation POST is fenced before body ingest and persistence", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-wearable-fence-"));
  const roleDir = path.join(root, "roles", "YeYu");
  const registry=new ManagerPluginRouteRegistry(),registration=registry.registerOperations('health-lifecycle-fixture',createPersonaHealthOperations({roleDirectory:()=>roleDir,identity:()=>({applicationGenerationId,managerInstanceId}),lifecycleFence:{applicationGenerationId,managerInstanceId},managerPort:0,deliverAlert:async()=>{throw new Error('No alert expected');}}));
  const server = http.createServer((request, response) => {
    if(!registry.handle(request,new URL(request.url??'/','http://fixture.invalid'),response))response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();await registration.dispose();
    await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('rabiroute-wearable-fence-'));fs.rmSync(root, { recursive: true, force: true });
  });
  const port = (server.address() as AddressInfo).port;

  const missing = await postObservation(port, {
    "x-rabiroute-expected-application-generation-id": applicationGenerationId
  });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.body.state, "invalid_lifecycle_fence");
  assert.equal(fs.existsSync(roleDir), false);

  const staleGeneration = await postObservation(port, {
    "x-rabiroute-expected-application-generation-id": "application-generation-old",
    "x-rabiroute-expected-manager-instance-id": managerInstanceId
  });
  assert.equal(staleGeneration.statusCode, 409);
  assert.equal(staleGeneration.body.state, "stale_lifecycle_fence");
  assert.equal(fs.existsSync(roleDir), false);

  const staleManager = await postObservation(port, {
    "x-rabiroute-expected-application-generation-id": applicationGenerationId,
    "x-rabiroute-expected-manager-instance-id": "manager-instance-old"
  });
  assert.equal(staleManager.statusCode, 409);
  assert.equal(staleManager.body.state, "stale_lifecycle_fence");
  assert.equal(fs.existsSync(roleDir), false);

  const accepted = await postObservation(port, {
    "x-rabiroute-expected-application-generation-id": applicationGenerationId,
    "x-rabiroute-expected-manager-instance-id": managerInstanceId
  });
  assert.equal(accepted.statusCode, 202);
  assert.equal(accepted.body.code, 0);
  assert.equal(fs.existsSync(roleDir), true);
  assert.ok(fs.readdirSync(roleDir, { recursive: true }).length > 0);
});
