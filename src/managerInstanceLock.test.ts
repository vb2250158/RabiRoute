import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  acquireManagerInstanceLock,
  ManagerInstanceAlreadyRunningError
} from "./managerInstanceLock.js";

test("Manager instance lock rejects a second live owner and releases cleanly", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-manager-lock-"));
  try {
    const first = acquireManagerInstanceLock({
      rootDir,
      pid: 101,
      ownerId: "first",
      isProcessAlive: (pid) => pid === 101
    });

    assert.throws(
      () => acquireManagerInstanceLock({
        rootDir,
        pid: 202,
        ownerId: "second",
        isProcessAlive: (pid) => pid === 101
      }),
      (error) => error instanceof ManagerInstanceAlreadyRunningError
        && error.owner.pid === 101
        && error.owner.ownerId === "first"
    );

    first.release();
    const second = acquireManagerInstanceLock({
      rootDir,
      pid: 202,
      ownerId: "second",
      isProcessAlive: () => false
    });
    second.release();
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Manager instance lock reclaims a stale owner without letting stale cleanup remove the new lock", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-manager-lock-stale-"));
  try {
    const stale = acquireManagerInstanceLock({
      rootDir,
      pid: 303,
      ownerId: "stale",
      isProcessAlive: () => false
    });
    const current = acquireManagerInstanceLock({
      rootDir,
      pid: 404,
      ownerId: "current",
      isProcessAlive: () => false
    });

    stale.release();
    assert.equal(fs.existsSync(current.lockPath), true);
    assert.equal(JSON.parse(fs.readFileSync(current.lockPath, "utf8")).ownerId, "current");

    current.release();
    assert.equal(fs.existsSync(current.lockPath), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
