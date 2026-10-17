import assert from "node:assert/strict";
import childProcess, { type ExecFileOptions } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

test("NapCat scanning hides its PowerShell probe and preserves the discovered process", { skip: process.platform !== "win32" }, async t => {
  const calls: Array<{ command: string; options: ExecFileOptions }> = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-hidden-probe-"));
  const execute = Object.assign(() => { throw new Error("Use the promisified probe"); }, {
    [promisify.custom]: async (command: string, _args: string[], options: ExecFileOptions) => {
      calls.push({ command, options });
      return { stdout: "QQ.exe\t4242\r\n", stderr: "" };
    }
  });
  const original = childProcess.execFile;
  Reflect.set(childProcess, "execFile", execute);
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.execFile = original;
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { scanNapcatEndpoint } = await import("./napcatManager.js");
  const result = await scanNapcatEndpoint({
    rootDir: root,
    getRuntimes: () => [],
    normalizeNapCatInstances: () => [],
    appendLog: () => undefined,
    checkHttpEndpoint: async () => false
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "powershell.exe");
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.timeout, 3000);
  assert.equal(result.installed, true);
  assert.equal(result.requirements?.find(requirement => requirement.id === "process")?.detail, "QQ.exe(4242)");
});
