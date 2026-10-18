import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execute } from "./managerReadWorkerTasks.js";

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
