import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execute } from "./managerReadWorkerTasks.js";
import { managerKnowledgePageWorkerPool, managerMemoryCatalogWorkerPool } from "./managerReadWorkerPool.js";

test("memory pages derive rows and counts from one fresh asynchronous catalog", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-memory-page-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (let index = 0; index < 23; index++) {
    const directory = path.join(root, "memory", index === 22 ? "consolidated" : "recent");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `memory-${index}.json`), JSON.stringify({
      id: `memory-${index}`, title: `Memory ${index}`, focus: "One subject", content: "Current source",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), keywords: ["needle"],
      ...(index === 21 ? { consolidatedAt: new Date().toISOString() } : {})
    }));
  }
  const read = fs.readFileSync;
  let synchronousMemoryReads = 0;
  fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (String(file).includes(`${path.sep}memory${path.sep}`)) synchronousMemoryReads++;
    return Reflect.apply(read, fs, [file, ...args]);
  }) as typeof read;
  t.after(() => { fs.readFileSync = read; });
  const result = await execute({ type: "role_memory_page", roleDir: root, kind: "recent", cursor: "", limit: 20, query: "" });
  fs.readFileSync = read;
  assert.equal(synchronousMemoryReads, 0);
  assert.ok(result && typeof result === "object" && "items" in result && "counts" in result && "total" in result);
  assert.equal(result.total, 21);
  assert.ok(Array.isArray(result.items));
  assert.equal(result.items.length, 20);
  assert.deepEqual(result.counts, { recent: 21, archived: 1, consolidated: 1, consolidationRuns: 0 });
});

test("managed memory pages retain one reader and observe external edits across categories", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-resident-memory-"));
  t.after(async () => {
    await Promise.all([managerKnowledgePageWorkerPool.stop(), managerMemoryCatalogWorkerPool.stop()]);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const directory = path.join(root, "memory", "recent");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "memory-demo.json");
  const memory = { id: "memory-demo", title: "Original", content: "Current source", focus: "One subject",
    keywords: ["needle"], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(memory));
  const page = (kind: "recent" | "consolidated") => managerKnowledgePageWorkerPool.queryRoleMemoryPage<{ items: Array<{ title: string }> }>(root, {
    kind, cursor: "", limit: 20, query: ""
  });
  const first = await page("recent");
  assert.equal(first.items[0]?.title, "Original");
  const pids = managerMemoryCatalogWorkerPool.status().workerPids;
  await page("consolidated");
  fs.writeFileSync(file, JSON.stringify({ ...memory, title: "Externally updated" }));
  assert.equal((await page("recent")).items[0]?.title, "Externally updated");
  assert.equal(managerMemoryCatalogWorkerPool.status().workers, 1);
  assert.deepEqual(managerMemoryCatalogWorkerPool.status().workerPids, pids);
});
