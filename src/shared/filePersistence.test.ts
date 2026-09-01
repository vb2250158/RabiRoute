import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { atomicWriteFileSync, withFileLockSync } from "./filePersistence.js";

test("file lock never retries a business action that throws lock-like errors", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-file-lock-action-"));
  const lockPath = path.join(root, "state", "writer.lock");
  try {
    for (const code of process.platform === "win32" ? ["EEXIST", "EPERM"] : ["EEXIST"]) {
      let runs = 0;
      assert.throws(() => withFileLockSync(lockPath, () => {
        runs += 1;
        const error = new Error(`injected business ${code}`) as NodeJS.ErrnoException;
        error.code = code;
        throw error;
      }), new RegExp(`business ${code}`));
      assert.equal(runs, 1);
      assert.equal(fs.existsSync(lockPath), false);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("file lock retries a Windows exclusive-create EPERM race without an existsSync probe", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-file-lock-eperm-race-"));
  const lockPath = path.join(root, "state", "writer.lock");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, "competing lock", "utf8");
  const originalOpenSync = fs.openSync;
  const originalExistsSync = fs.existsSync;
  let openAttempts = 0;
  try {
    fs.openSync = ((filePath, flags, mode) => {
      if (path.resolve(String(filePath)) === path.resolve(lockPath) && flags === "wx") {
        openAttempts += 1;
        if (openAttempts === 1) {
          fs.unlinkSync(lockPath);
          const error = new Error("injected released Windows exclusive-create race") as NodeJS.ErrnoException;
          error.code = "EPERM";
          error.errno = -4048;
          error.syscall = "open";
          error.path = lockPath;
          throw error;
        }
      }
      return originalOpenSync(filePath, flags, mode);
    }) as typeof fs.openSync;
    fs.existsSync = ((filePath) => {
      if (path.resolve(String(filePath)) === path.resolve(lockPath)) {
        throw new Error("file-lock acquisition must not probe existsSync after EPERM");
      }
      return originalExistsSync(filePath);
    }) as typeof fs.existsSync;

    const result = withFileLockSync(lockPath, () => "acquired", { timeoutMs: 100 });

    assert.equal(result, "acquired");
    assert.equal(openAttempts, 2);
  } finally {
    fs.openSync = originalOpenSync;
    fs.existsSync = originalExistsSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("file lock rejects non-contention EPERM errors without retrying", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-file-lock-permission-"));
  const lockPath = path.join(root, "state", "writer.lock");
  const originalOpenSync = fs.openSync;
  const denied = new Error("injected non-contention permission failure") as NodeJS.ErrnoException;
  denied.code = "EPERM";
  denied.syscall = "chmod";
  denied.path = lockPath;
  let openAttempts = 0;
  try {
    fs.openSync = ((filePath, flags, mode) => {
      if (path.resolve(String(filePath)) === path.resolve(lockPath) && flags === "wx") {
        openAttempts += 1;
        throw denied;
      }
      return originalOpenSync(filePath, flags, mode);
    }) as typeof fs.openSync;

    assert.throws(
      () => withFileLockSync(lockPath, () => "unreachable", { timeoutMs: 100 }),
      error => error === denied
    );
    assert.equal(openAttempts, 1);
  } finally {
    fs.openSync = originalOpenSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("file lock reports its existing deadline exactly when contention does not clear", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-file-lock-timeout-"));
  const lockPath = path.join(root, "state", "writer.lock");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, `${JSON.stringify({
    owner: "current-test-owner",
    host: os.hostname(),
    pid: process.pid,
    createdAt: 1_000
  })}\n`, "utf8");
  const originalOpenSync = fs.openSync;
  const originalNow = Date.now;
  const nowValues = [1_000, 1_099, 1_100];
  let openAttempts = 0;
  try {
    Date.now = () => nowValues.shift() ?? 1_100;
    fs.openSync = ((filePath, flags, mode) => {
      if (path.resolve(String(filePath)) === path.resolve(lockPath) && flags === "wx") {
        openAttempts += 1;
        const error = new Error("injected active lock") as NodeJS.ErrnoException;
        error.code = "EEXIST";
        throw error;
      }
      return originalOpenSync(filePath, flags, mode);
    }) as typeof fs.openSync;

    assert.throws(
      () => withFileLockSync(lockPath, () => "unreachable", { timeoutMs: 100 }),
      error => error instanceof Error && error.message === `Timed out waiting for file lock: ${lockPath}`
    );
    assert.equal(openAttempts, 2);
  } finally {
    fs.openSync = originalOpenSync;
    Date.now = originalNow;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("atomic write retries transient Windows/SMB rename failures without losing the previous file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-atomic-write-"));
  const target = path.join(root, "manifest-index.json");
  fs.writeFileSync(target, "before", "utf8");
  let renameAttempts = 0;
  try {
    atomicWriteFileSync(target, "after", {
      maxRenameAttempts: 3,
      retryDelayMs: 1,
      renameSync: (source, destination) => {
        renameAttempts += 1;
        if (renameAttempts < 3) {
          assert.equal(fs.readFileSync(target, "utf8"), "before");
          const error = new Error("injected transient SMB rename failure") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        }
        fs.renameSync(source, destination);
      }
    });

    assert.equal(renameAttempts, 3);
    assert.equal(fs.readFileSync(target, "utf8"), "after");
    assert.deepEqual(fs.readdirSync(root), ["manifest-index.json"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
