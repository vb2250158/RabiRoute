import assert from "node:assert/strict";
import test from "node:test";
import { stopChildProcessTree } from "./windowsProcessTree.js";

test("Windows process-tree stop delegates the PID without calling plain kill", async () => {
  const pids: number[] = [];
  let killed = false;
  await stopChildProcessTree({ pid: 42, exitCode: null, kill: () => { killed = true; return true; } }, {
    platform: "win32",
    runWindows: async pid => { pids.push(pid); }
  });
  assert.deepEqual(pids, [42]);
  assert.equal(killed, false);
});

test("non-Windows process stop uses SIGTERM and ignores an exited child", async () => {
  const signals: Array<NodeJS.Signals | undefined> = [];
  await stopChildProcessTree({ pid: 7, exitCode: null, kill: signal => { signals.push(signal); return true; } }, { platform: "linux" });
  await stopChildProcessTree({ pid: 8, exitCode: 0, kill: signal => { signals.push(signal); return true; } }, { platform: "linux" });
  assert.deepEqual(signals, ["SIGTERM"]);
});
