import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { promisify } from "node:util";
import { acquireFileLockSync, atomicWriteFileSync, withFileLockSync } from "./filePersistence.js";

const windowsOnly = { skip: process.platform !== "win32" };

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

test("Windows file lock recovers legacy records after PID reuse", windowsOnly, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-file-lock-reused-pid-"));
  const lockPath = path.join(root, "writer.lock");
  const old = new Date(Date.now() - 86_400_000);
  try {
    fs.writeFileSync(lockPath, JSON.stringify({ owner: "previous-process", pid: process.pid, createdAt: old.getTime() }));
    fs.utimesSync(lockPath, old, old);

    withFileLockSync(lockPath, () => {
      const acquired = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      assert.match(acquired.processStartedAtFileTime, /^\d+$/);
      assert.notEqual(acquired.owner, "previous-process");
    }, { timeoutMs: 200, staleMs: 200 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows file lock preserves live and unidentifiable legacy owners", windowsOnly, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-file-lock-live-pid-"));
  const lockPath = path.join(root, "writer.lock");
  const old = new Date(Date.now() - 86_400_000);
  const options = { timeoutMs: 40, staleMs: 40 };
  try {
    const release = acquireFileLockSync(lockPath);
    try {
      fs.utimesSync(lockPath, old, old);
      assert.throws(() => acquireFileLockSync(lockPath, options), /Timed out waiting/);
    } finally {
      release();
    }
    const legacyOwners = [
      { owner: "legacy", pid: process.pid },
      { owner: "legacy", pid: process.pid, createdAt: Date.now() }
    ];
    for (const owner of legacyOwners) {
      const original = JSON.stringify(owner);
      fs.writeFileSync(lockPath, original);
      fs.utimesSync(lockPath, old, old);
      assert.throws(() => acquireFileLockSync(lockPath, options), /Timed out waiting/);
      assert.equal(fs.readFileSync(lockPath, "utf8"), original);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows file lock recovers a stale record from an exited process", windowsOnly, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-file-lock-exited-pid-"));
  const lockPath = path.join(root, "writer.lock");
  try {
    const exited = spawnSync(process.execPath, ["-e", ""], { timeout: 5_000 });
    assert.equal(exited.status, 0);
    const old = new Date(Date.now() - 86_400_000);
    fs.writeFileSync(lockPath, JSON.stringify({ owner: "exited-process", pid: exited.pid }));
    fs.utimesSync(lockPath, old, old);
    const release = acquireFileLockSync(lockPath, { timeoutMs: 200, staleMs: 200 });
    release();
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows file lock recovers an exited owner while its process handle stays open", windowsOnly, async () => {
  const koffi = createRequire(import.meta.url)("koffi") as typeof import("koffi");
  const kernel = koffi.load("kernel32.dll");
  const openProcess = kernel.func("__stdcall", "OpenProcess", "intptr_t", ["uint32", "int", "uint32"]);
  const getProcessTimes = kernel.func("__stdcall", "GetProcessTimes", "int", ["intptr_t", "void *", "void *", "void *", "void *"]);
  const closeHandle = kernel.func("__stdcall", "CloseHandle", "int", ["intptr_t"]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-file-lock-held-process-"));
  const lockPath = path.join(root, "writer.lock");
  const child = spawn(process.execPath, ["-e", "process.stdin.once('data', () => process.exit(259))"], { stdio: ["pipe", "ignore", "ignore"] });
  const exited = once(child, "exit");
  try {
    assert.ok(child.pid);
    const handle = openProcess(0x1000, 0, child.pid); // PROCESS_QUERY_LIMITED_INFORMATION
    assert.ok(handle);
    try {
      const times = Buffer.alloc(32);
      const readTimes = () => getProcessTimes(handle, times, times.subarray(8), times.subarray(16), times.subarray(24));
      assert.equal(readTimes(), 1);
      const recordedStart = times.readBigUInt64LE().toString();
      fs.writeFileSync(lockPath, JSON.stringify({
        owner: "child", pid: child.pid, createdAt: Date.now(), processStartedAtFileTime: recordedStart
      }));
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(lockPath, old, old);
      const options = { timeoutMs: 100, staleMs: 100 };
      assert.throws(() => acquireFileLockSync(lockPath, options), /Timed out waiting/);

      child.stdin.end("exit");
      assert.deepEqual(await exited, [259, null], "An actual exit code can also equal STILL_ACTIVE");
      assert.equal(readTimes(), 1, "The exited process still exposes its original birth time");
      assert.equal(times.readBigUInt64LE().toString(), recordedStart);
      const release = acquireFileLockSync(lockPath, options);
      release();
      assert.equal(fs.existsSync(lockPath), false);
    } finally {
      closeHandle(handle);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited.catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows file lock rechecks the actual file when the stale candidate is replaced", windowsOnly, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-file-lock-replaced-"));
  const lockPath = path.join(root, "writer.lock");
  const replacement = path.join(root, "replacement.lock");
  const old = new Date(Date.now() - 86_400_000);
  const originalRead = fs.readFileSync;
  let replaced = false;
  try {
    fs.writeFileSync(lockPath, JSON.stringify({ owner: "old", pid: process.pid, createdAt: old.getTime() }));
    fs.utimesSync(lockPath, old, old);
    const live = JSON.stringify({ owner: "live", pid: process.pid, createdAt: Date.now() });
    fs.writeFileSync(replacement, live);
    fs.utimesSync(replacement, old, old);
    fs.readFileSync = ((file, options) => {
      const contents = originalRead(file, options);
      if (file === lockPath && !replaced) {
        fs.renameSync(replacement, lockPath);
        replaced = true;
      }
      return contents;
    }) as typeof fs.readFileSync;

    assert.throws(() => acquireFileLockSync(lockPath, { timeoutMs: 50, staleMs: 50 }), /Timed out waiting/);
    assert.equal(replaced, true);
    assert.equal(originalRead(lockPath, "utf8"), live);
  } finally {
    fs.readFileSync = originalRead;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows concurrent stale-lock contenders enter the critical section one at a time", windowsOnly, async () => {
  const root = fs.mkdtempSync(path.join(process.env.RABI_FILE_LOCK_TEST_ROOT || os.tmpdir(), "rabiroute-file-lock-contenders-"));
  const lockPath = path.join(root, "writer.lock");
  const guardPath = path.join(root, "critical-section");
  const goPath = path.join(root, "start");
  const old = new Date(Date.now() - 86_400_000);
  const sourceMode = import.meta.url.endsWith(".ts");
  const moduleUrl = new URL(sourceMode ? "./filePersistence.ts" : "./filePersistence.js", import.meta.url);
  const child = `
    import fs from "node:fs";
    import { setTimeout as delay } from "node:timers/promises";
    import { withFileLockSync } from ${JSON.stringify(moduleUrl.href)};
    const [lockPath, guardPath, goPath, readyPath] = process.argv.slice(1);
    fs.writeFileSync(readyPath, "ready");
    while (!fs.existsSync(goPath)) await delay(10);
    withFileLockSync(lockPath, () => {
      const guard = fs.openSync(guardPath, "wx");
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
      } finally {
        fs.closeSync(guard);
        fs.unlinkSync(guardPath);
      }
    }, { timeoutMs: 4_000, staleMs: 4_000 });
  `;
  try {
    fs.writeFileSync(lockPath, JSON.stringify({ owner: "previous-process", pid: process.pid, createdAt: old.getTime() }));
    fs.utimesSync(lockPath, old, old);
    const readyPaths = Array.from({ length: 6 }, (_, index) => path.join(root, `ready-${index}`));
    const loader = sourceMode ? ["--import", import.meta.resolve("tsx")] : [];
    const run = promisify(execFile);
    const contenders = Promise.allSettled(readyPaths.map(readyPath => run(process.execPath,
      [...loader, "--input-type=module", "-e", child, lockPath, guardPath, goPath, readyPath], { timeout: 15_000 })));
    const readyDeadline = Date.now() + 8_000;
    while (Date.now() < readyDeadline && !readyPaths.every(file => fs.existsSync(file))) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const startedTogether = readyPaths.every(file => fs.existsSync(file));
    fs.writeFileSync(goPath, "start");
    const results = await contenders;
    assert.equal(startedTogether, true, results.map(result => result.status === "rejected" ? String(result.reason) : "").join("\n"));
    for (const result of results) if (result.status === "rejected") throw result.reason;
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(fs.existsSync(guardPath), false);
  } finally {
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
