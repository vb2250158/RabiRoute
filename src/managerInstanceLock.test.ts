import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  acquireManagerInstanceLock,
  ManagerInstanceAlreadyRunningError,
  managerInstanceLeaseAddress
} from "./managerInstanceLock.js";

test("Manager OS lease rejects a second owner across different metadata roots and releases cleanly", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-manager-lock-"));
  const otherRootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-manager-lock-other-"));
  const ownershipNamespace = `test-${process.pid}-${Date.now()}-cross-root`;
  try {
    const first = await acquireManagerInstanceLock({ rootDir, ownershipNamespace, pid: 101, ownerId: "first" });
    await assert.rejects(
      acquireManagerInstanceLock({ rootDir: otherRootDir, ownershipNamespace, pid: 202, ownerId: "second" }),
      (error: unknown) => error instanceof ManagerInstanceAlreadyRunningError
        && error.owner.pid === 101
        && error.owner.ownerId === "first"
    );
    await first.release();
    const second = await acquireManagerInstanceLock({ rootDir: otherRootDir, ownershipNamespace, pid: 202, ownerId: "second" });
    await second.release();
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(otherRootDir, { recursive: true, force: true });
  }
});

test("stale diagnostic metadata cannot block an OS-released Manager lease", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-manager-lock-stale-"));
  try {
    const runtimeDir = path.join(rootDir, "data", ".runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, "manager-instance.lock"), `${JSON.stringify({
      pid: process.pid,
      ownerId: "stale-reused-pid",
      startedAt: "2000-01-01T00:00:00.000Z",
      projectRoot: rootDir
    })}\n`);
    const current = await acquireManagerInstanceLock({
      rootDir,
      ownershipNamespace: `test-${process.pid}-${Date.now()}-stale`,
      ownerId: "current"
    });
    assert.equal(JSON.parse(fs.readFileSync(current.lockPath, "utf8")).ownerId, "current");
    await current.release();
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Manager lease identity is stable for one ownership namespace and independent of metadata roots", () => {
  assert.equal(managerInstanceLeaseAddress("user-a"), managerInstanceLeaseAddress("user-a"));
  assert.notEqual(managerInstanceLeaseAddress("user-a"), managerInstanceLeaseAddress("user-b"));
});
