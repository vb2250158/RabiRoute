import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRecentMemory, roleKnowledgeSnapshotFromStorage } from "../roleKnowledge.js";

test("recalling a cached memory reads only its current file before updating view metadata", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-context-view-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (let index = 0; index < 12; index++) createRecentMemory(root, {
    id: `memory-${index}`, title: `Memory ${index}`, focus: "One subject", content: "Original content",
    keywords: [index === 0 ? "needle" : `unrelated-${index}`]
  });
  roleKnowledgeSnapshotFromStorage(root, "", { touchViewedAt: false });
  const target = path.join(root, "memory", "recent", "memory-0.md");
  const original = fs.readFileSync(target, "utf8");
  fs.writeFileSync(target, original.replace("Original content", "Current content"));
  const read = fs.readFileSync;
  const readFiles: string[] = [];
  fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (typeof file === "string" && file.includes(`${path.sep}memory${path.sep}recent${path.sep}`) && file.endsWith(".md")) readFiles.push(file);
    return Reflect.apply(read, fs, [file, ...args]);
  }) as typeof fs.readFileSync;
  t.after(() => { fs.readFileSync = read; });
  const snapshot = roleKnowledgeSnapshotFromStorage(root, "needle", { archiveCompletedPlans: false });
  fs.readFileSync = read;
  assert.equal(snapshot.requiredReadItems.length, 1);
  assert.ok(readFiles.length <= 1, `metadata-only recall read ${readFiles.length} memory files`);
  const stored = fs.readFileSync(target, "utf8");
  assert.match(stored, /Current content/);
  assert.match(stored, /viewedAt/);
  assert.match(stored, /recalledAt/);
});
