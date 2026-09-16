import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runManagerCommand } from "../lib/manager-cli.mjs";

test("CLI uses registered identity, preserves stdin JSON and never exports credentials", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-cli-"));
  const configPath = path.join(dir, "config.json");
  const config = { managerUrl: "http://manager.invalid", nodeCredential: "fixture-node-only", agents: [{ agentId: "worker", enabled: true }] };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const meta = { health: { state: "healthy", requiredReady: true }, applicationGenerationId: "g", managerInstanceId: "m" };
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(options);
    return Response.json(String(url).endsWith("/meta") ? meta : { code: 0 });
  };
  try {
    const body = '{ "title": "Example" }';
    const receipt = await runManagerCommand(["--api", "POST", "/api/roles/example/plans", "--agent", "worker", "--body-stdin", "--idempotency-key", "fixture-key"], configPath, { fetchImpl, readInput: async () => body });
    assert.equal(receipt.ok, true);
    assert.equal(calls[1].body, body);
    assert.equal(calls[1].headers["idempotency-key"], "fixture-key");
    assert.ok(!JSON.stringify(receipt).includes(config.nodeCredential));
    await assert.rejects(runManagerCommand(["--api", "GET", "/meta"], configPath, { fetchImpl }), /registered Agent/);
    config.agents[0].enabled = false;
    fs.writeFileSync(configPath, JSON.stringify(config));
    await assert.rejects(runManagerCommand(["--api", "GET", "/meta", "--agent", "worker"], configPath, { fetchImpl }), /disabled/);
    delete config.nodeCredential;
    config.lanLinkToken = "old-shared-fixture";
    fs.writeFileSync(configPath, JSON.stringify(config));
    await assert.rejects(runManagerCommand(["--api", "GET", "/meta", "--agent", "worker"], configPath, { fetchImpl }), /independent node credential/);
    assert.equal(calls.length, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
