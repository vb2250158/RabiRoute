import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseAllowedCwdRoots, resolveRealDirectory, resolveRealFileWithinRoots, resolveTaskCwd } from "./cwd-policy.mjs";

test("cwd policy resolves real directories and rejects files or missing paths", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-cwd-policy-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const allowedDir = path.join(tempDir, "allowed");
  const filePath = path.join(tempDir, "file.txt");
  fs.mkdirSync(allowedDir);
  fs.writeFileSync(filePath, "not a directory", "utf8");

  const roots = parseAllowedCwdRoots(undefined, allowedDir);
  assert.equal(resolveTaskCwd(allowedDir, { defaultCwd: allowedDir, allowedCwdRoots: roots }), fs.realpathSync.native(allowedDir));
  assert.throws(() => resolveRealDirectory(filePath), /not a directory/);
  assert.throws(() => resolveRealDirectory(path.join(tempDir, "missing")), /does not exist or cannot be resolved/);
});

test("cwd policy rejects a junction or symlink that escapes an allowed root", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-cwd-policy-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const allowedDir = path.join(tempDir, "allowed");
  const outsideDir = path.join(tempDir, "outside");
  const escapePath = path.join(allowedDir, "escape");
  fs.mkdirSync(allowedDir);
  fs.mkdirSync(outsideDir);
  fs.symlinkSync(outsideDir, escapePath, process.platform === "win32" ? "junction" : "dir");

  const roots = parseAllowedCwdRoots(undefined, allowedDir);
  assert.throws(
    () => resolveTaskCwd(escapePath, { defaultCwd: allowedDir, allowedCwdRoots: roots }),
    /outside REMOTE_AGENT_ALLOWED_CWDS/
  );
});

test("result files must resolve inside the current task cwd", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-cwd-policy-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const taskDir = path.join(tempDir, "task");
  const outsideDir = path.join(tempDir, "outside");
  fs.mkdirSync(taskDir);
  fs.mkdirSync(outsideDir);
  const insideFile = path.join(taskDir, "inside.txt");
  const outsideFile = path.join(outsideDir, "outside.txt");
  const escapeDir = path.join(taskDir, "escape");
  fs.writeFileSync(insideFile, "inside", "utf8");
  fs.writeFileSync(outsideFile, "outside", "utf8");
  fs.symlinkSync(outsideDir, escapeDir, process.platform === "win32" ? "junction" : "dir");

  const realTaskDir = fs.realpathSync.native(taskDir);
  assert.equal(resolveRealFileWithinRoots(insideFile, [realTaskDir]), fs.realpathSync.native(insideFile));
  assert.throws(() => resolveRealFileWithinRoots(outsideFile, [realTaskDir]), /outside the current task cwd/);
  assert.throws(() => resolveRealFileWithinRoots(path.join(escapeDir, "outside.txt"), [realTaskDir]), /outside the current task cwd/);
});
