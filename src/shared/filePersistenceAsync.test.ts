import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { renameFileWithRetry } from "./filePersistence.js";

test("async replacement preserves the old file, yields during contention and commits once", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-async-rename-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, "preview.json"), temporary = target + ".partial";
  await fs.writeFile(target, "before"); await fs.writeFile(temporary, "after");
  let attempts = 0, yielded = false;
  const timer = setTimeout(() => { yielded = true; }, 0);
  t.after(() => clearTimeout(timer));
  await renameFileWithRetry(temporary, target, { maxRenameAttempts: 3, retryDelayMs: 1, rename: async (source, destination) => {
    attempts++;
    assert.equal(await fs.readFile(target, "utf8"), "before");
    if (attempts < 3) throw Object.assign(new Error("contended"), { code: "EPERM" });
    assert.equal(yielded, true);
    await fs.rename(source, destination);
  } });
  assert.equal(attempts, 3);
  assert.equal(await fs.readFile(target, "utf8"), "after");
  assert.deepEqual(await fs.readdir(root), ["preview.json"]);
});

test("async replacement has a bounded failure and never retries unrelated filesystem errors", async () => {
  for (const [code, expected] of [["EPERM", 3], ["ENOENT", 1]] as const) {
    let attempts = 0;
    const failure = Object.assign(new Error("original failure"), { code });
    await assert.rejects(renameFileWithRetry("temporary", "target", {
      maxRenameAttempts: 3, retryDelayMs: 1,
      rename: async () => { attempts++; throw failure; }
    }), error => error === failure);
    assert.equal(attempts, expected);
  }
});
