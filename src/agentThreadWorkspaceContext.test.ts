import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleAgentThreadRequest, resolveAgentThreadWorkspaceForTest, type AgentThreadDriver } from "./agentThreads.js";

test("workspace validation accepts real directories without Route, persona or configured-workspace grants", () => {
  const outside = path.dirname(process.cwd());
  assert.equal(resolveAgentThreadWorkspaceForTest(outside, { allowedWorkspaces: [process.cwd()] }), outside);
  assert.equal(resolveAgentThreadWorkspaceForTest(outside, { allowedWorkspaces: [] }), outside);
  assert.equal(resolveAgentThreadWorkspaceForTest(undefined, { allowedWorkspaces: [], defaultWorkspace: outside }), outside);
  assert.equal(resolveAgentThreadWorkspaceForTest(undefined, { allowedWorkspaces: [] }), process.cwd());
});

test("removing workspace authorization retains actual directory validation", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "agent-context-"));
  const file = path.join(fixture, "file.txt");
  fs.writeFileSync(file, "fixture");
  try {
    assert.throws(() => resolveAgentThreadWorkspaceForTest(file, { allowedWorkspaces: [] }), /not a directory/);
    assert.throws(() => resolveAgentThreadWorkspaceForTest(path.join(fixture, "missing"), { allowedWorkspaces: [] }), /does not exist/);
  } finally {
    fs.unlinkSync(file);
    fs.rmdirSync(fixture);
  }
});

test("Manager's empty workspace filter lists multiple workspaces and retains query pagination", async () => {
  const calls: unknown[] = [];
  const rows = [{ id: "fixture-one", title: "query A", cwd: process.cwd(), updatedAt: "2026-10-10T00:00:00Z" }, { id: "fixture-two", title: "query B", cwd: path.dirname(process.cwd()), updatedAt: "2026-10-10T00:00:00Z" }];
  const driver: AgentThreadDriver = { list: async params => { calls.push(params); return rows; }, read: async () => ({}), create: async () => { throw new Error("not used"); }, send: async () => undefined };
  const result = await handleAgentThreadRequest({ action: "list", query: "query", limit: 5, offset: 2 }, { allowedWorkspaces: [] }, driver);
  assert.deepEqual(result.data.threads, rows);
  assert.deepEqual(calls, [{ query: "query", limit: 6, offset: 2, allowedWorkspaces: [] }]);
});
