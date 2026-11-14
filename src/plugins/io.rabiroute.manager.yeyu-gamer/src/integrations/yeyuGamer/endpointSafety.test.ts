import assert from "node:assert/strict";
import test from "node:test";
import { YeYuGamerManagerApiClient, normalizeYeYuGamerManagerConfig } from "./managerApi.js";

test("YeYu unconfigured operations stop before credential reads or requests", async () => {
  let reads = 0, requests = 0;
  const client = new YeYuGamerManagerApiClient(undefined, { readFile: async () => { reads++; return "fixture-token"; }, fetch: async () => { requests++; throw new Error("No guessed destination"); } });
  for (const operation of [() => client.getHealth(), () => client.getSnapshot(), () => client.createWorkItem({ kind: "observation" }, { idempotencyKey: "fixture-key", expectedStateVersion: 0 })]) {
    await assert.rejects(operation, (error: { code?: string }) => error.code === "yeyu_gamer_not_configured");
  }
  assert.equal(reads, 0);
  assert.equal(requests, 0);
});

test("YeYu accepts explicit dynamic loopback URLs and rejects foreign or malformed targets", async () => {
  for (const url of ["http://127.0.0.1:49131/api/v1", "https://localhost:49132/api/v1", "http://[::1]:49133/api/v1"]) assert.equal(normalizeYeYuGamerManagerConfig({ baseUrl: url }).baseUrl, url);
  for (const url of ["http://remote.example.invalid/api/v1", "http://127.0.0.1:0/api/v1", "http://fixture:secret@127.0.0.1:49131/api/v1", "http://127.0.0.1:49131/api/v1?token=fixture", "http://127.0.0.1:49131/other"]) assert.throws(() => normalizeYeYuGamerManagerConfig({ baseUrl: url }));
  const target = "http://127.0.0.1:49134/api/v1";
  let requested = "";
  const client = new YeYuGamerManagerApiClient({ baseUrl: target }, { fetch: async url => { requested = String(url); return Response.json({ name: "fixture", version: "1", apiVersion: "v1", managerId: "fixture", startedAt: "fixture", hostPolicy: "loopback-only", webGuiAvailable: false, legacyExecutionEnabled: false }); } });
  await client.getMeta();
  assert.equal(requested, target + "/meta");
});
