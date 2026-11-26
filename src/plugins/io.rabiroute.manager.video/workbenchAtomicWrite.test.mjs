import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// §9-6: on an SMB share a rename can fail transiently with EPERM/EACCES/EBUSY.
// The canvas must either retry to success or fail loudly — never leave a half
// file behind and never report a save that did not happen.
const { WorkbenchProjects } = await import("./workbenchProjects.mjs");

// Only the storage-owner file helpers are exercised, so the constructor is skipped
// and the two roots the guard reads are set directly.
async function store() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-atomic-"));
  const owner = Object.create(WorkbenchProjects.prototype);
  owner.root = root;
  owner.legacyRoot = path.join(root, ".legacy");
  owner.canonicalRoots = new Map();
  return { owner, root, file: path.join(root, "canvas.json") };
}

test("a transient rename failure is retried until the file lands", async () => {
  const { owner, file } = await store();
  let attempts = 0;
  const original = fs.rename;
  fs.rename = async (from, to) => {
    attempts++;
    if (attempts <= 2) { const error = new Error("operation not permitted"); error.code = "EPERM"; throw error; }
    return original(from, to);
  };
  try { await owner.atomic(file, { revision: 1 }); } finally { fs.rename = original; }
  assert.equal(attempts, 3);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { revision: 1 });
});

test("a persistent rename failure throws with an actionable message and leaves no temp file", async () => {
  const { owner, root, file } = await store();
  const original = fs.rename;
  fs.rename = async () => { const error = new Error("operation not permitted"); error.code = "EPERM"; throw error; };
  try { await assert.rejects(() => owner.atomic(file, { revision: 1 }), /网络盘|原子重命名/); }
  finally { fs.rename = original; }
  const leftovers = (await fs.readdir(root)).filter(name => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("a non-transient rename error is not retried", async () => {
  const { owner, file } = await store();
  let attempts = 0;
  const original = fs.rename;
  fs.rename = async () => { attempts++; const error = new Error("no such file"); error.code = "ENOENT"; throw error; };
  try { await assert.rejects(() => owner.atomic(file, { revision: 1 })); } finally { fs.rename = original; }
  assert.equal(attempts, 1);
});
