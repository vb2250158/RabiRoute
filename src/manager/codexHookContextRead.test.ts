import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CodexHookContextReadReply } from "./codexHookContextRead.js";
import { managerKnowledgePageWorkerPool } from "./managerReadWorkerPool.js";
import { readRoleMemoryCatalogsInWorker } from "../roleKnowledge.js";
import { readCodexHookContextInputAsync } from "./codexHookContextRead.js";

test("Hook context consumes the current shared physical catalog without rereading memory bodies", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hook-shared-memory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "memory", "recent");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "memory-demo.json"), JSON.stringify({ id: "memory-demo", title: "Needle",
    focus: "Needle", content: "Physical source", keywords: ["Needle"],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  const memories = await readRoleMemoryCatalogsInWorker(root);
  const read = fs.promises.readFile;
  let memoryReads = 0;
  fs.promises.readFile = (async (...args: Parameters<typeof read>) => {
    if (String(args[0]).includes(`${path.sep}memory${path.sep}`)) memoryReads++;
    return Reflect.apply(read, fs.promises, args);
  }) as typeof read;
  t.after(() => { fs.promises.readFile = read; });
  const input = { kind: "knowledge" as const, trigger: {
    kind: "preview" as const, source: "codex_hook" as const, roleId: "Demo", roleDir: root, signalText: "Needle"
  }, memories };
  const result = await readCodexHookContextInputAsync(input);
  assert.equal(result.kind === "knowledge" && result.resolution.knowledge.requiredReadItems[0]?.id, "memory-demo");
  assert.equal(memoryReads, 0);
  await assert.rejects(readCodexHookContextInputAsync({ ...input, memories: { ...memories, roleDir: path.join(root, "Other") } }), /another persona/);
});

test("physical hook worker reads current role source and storage knowledge without a published catalog", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hook-context-worker-"));
  const roleDir = path.join(root, "DemoPersona");
  fs.mkdirSync(path.join(roleDir, "memory", "recent"), { recursive: true });
  const personaPath = path.join(roleDir, "persona.md");
  fs.writeFileSync(personaPath, "Current demo persona");
  const timestamp = new Date().toISOString();
  fs.writeFileSync(path.join(roleDir, "memory", "recent", "memory-demo.json"), JSON.stringify({
    id: "memory-demo", title: "worker recall", focus: "worker recall", content: "fresh physical evidence",
    createdAt: timestamp, updatedAt: timestamp, keywords: ["worker recall"]
  }));
  try {
    const readSource = () => managerKnowledgePageWorkerPool.run<CodexHookContextReadReply>({
      type: "codex_hook_context_read", input: { kind: "role_source", rolesRoot: root, roleId: "DemoPersona" }
    });
    let source = await readSource();
    assert.equal(source.kind, "role_source");
    if (source.kind !== "role_source") throw new Error("Unexpected worker reply");
    assert.equal(source.source.persona, "Current demo persona");
    fs.writeFileSync(personaPath, "Updated demo persona");
    source = await readSource();
    assert.equal(source.kind === "role_source" && source.source.persona, "Updated demo persona");
    const knowledge = await managerKnowledgePageWorkerPool.run<CodexHookContextReadReply>({
      type: "codex_hook_context_read", input: { kind: "knowledge", trigger: {
        kind: "user_prompt", source: "codex_hook", roleId: "DemoPersona", roleDir, signalText: "worker recall"
      } }
    });
    assert.equal(knowledge.kind, "knowledge");
    if (knowledge.kind !== "knowledge") throw new Error("Unexpected worker reply");
    assert.ok(knowledge.resolution.knowledge.requiredReadItems.some(item => item.id === "memory-demo"));
    assert.equal(knowledge.resolution.policy.touchViewedAt, true);
  } finally {
    await managerKnowledgePageWorkerPool.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
