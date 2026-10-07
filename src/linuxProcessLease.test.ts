import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { acquireLinuxProcessLease, linuxProcessLeasePaths, LinuxProcessLeaseAlreadyHeldError } from "./linuxProcessLease.js";
import { acquireManagerInstanceLock, managerInstanceLeaseAddress } from "./managerInstanceLock.js";

const linuxOnly = { skip: process.platform !== "linux" };
const owner = (ownerId: string) => ({ ownerId, pid: process.pid, startedAt: new Date().toISOString(), projectRoot: "/fixture" });
function fixtureNamespace() { return `rabiroute-test-${randomUUID()}`; }
function removeFixtureLease(namespace: string): void {
  const files = linuxProcessLeasePaths(namespace);
  for (const file of [files.ownerPath, files.leasePath]) fs.rmSync(file, { force: true });
}

async function childReady(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Fixture process readiness timed out.")), 10_000);
    let output = "";
    const onData = (value: Buffer) => { output += value.toString("utf8"); if (output.includes("LEASE_READY\n")) finish(); };
    const onExit = (code: number | null) => finish(new Error(`Fixture process exited before ready (${code}).`));
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
      error ? reject(error) : resolve();
    };
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
    child.once("error", finish);
  });
}

test("Linux kernel lease keeps a stable inode, rejects contenders, and releases idempotently", linuxOnly, async () => {
  const namespace = fixtureNamespace();
  try {
    const first = await acquireLinuxProcessLease({ namespace, owner: owner("first") });
    const inode = fs.statSync(first.leasePath).ino;
    assert.equal(fs.statSync(first.leasePath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(first.ownerPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(first.leasePath)).mode & 0o777, 0o700);
    try {
      await assert.rejects(acquireLinuxProcessLease({ namespace, owner: owner("second") }),
        error => error instanceof LinuxProcessLeaseAlreadyHeldError && error.owner?.ownerId === "first");
    } finally { await first.release(); }
    await first.release();
    const second = await acquireLinuxProcessLease({ namespace, owner: owner("second") });
    try { assert.equal(fs.statSync(second.leasePath).ino, inode); }
    finally { await second.release(); }
  } finally { removeFixtureLease(namespace); }
});

test("Linux lease ignores stale diagnostic PIDs and metadata once the kernel lease is free", linuxOnly, async () => {
  const namespace = fixtureNamespace();
  try {
    const first = await acquireLinuxProcessLease({ namespace, owner: owner("first") });
    const { ownerPath } = first;
    await first.release();
    fs.writeFileSync(ownerPath, JSON.stringify(owner("stale-but-pid-alive")), { mode: 0o600 });
    const second = await acquireLinuxProcessLease({ namespace, owner: owner("current") });
    try { assert.equal(JSON.parse(fs.readFileSync(ownerPath, "utf8")).ownerId, "current"); }
    finally { await second.release(); }
  } finally { removeFixtureLease(namespace); }
});

test("Linux kernel lease releases after SIGKILL without PID recovery or metadata removal", linuxOnly, async () => {
  const namespace = fixtureNamespace();
  const moduleUrl = new URL("./linuxProcessLease.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { acquireLinuxProcessLease } from ${JSON.stringify(moduleUrl)};
    await acquireLinuxProcessLease({ namespace: ${JSON.stringify(namespace)}, owner: { pid: process.pid, ownerId: "crash-fixture" } });
    process.stdout.write("LEASE_READY\\n");
    setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    await childReady(child);
    await assert.rejects(acquireLinuxProcessLease({ namespace, owner: owner("contender") }), LinuxProcessLeaseAlreadyHeldError);
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    assert.equal(JSON.parse(fs.readFileSync(linuxProcessLeasePaths(namespace).ownerPath, "utf8")).ownerId, "crash-fixture");
    const recovered = await acquireLinuxProcessLease({ namespace, owner: owner("recovered") });
    await recovered.release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
    removeFixtureLease(namespace);
  }
});

test("Linux lease refuses symlinks, hardlinks and unsafe file permissions", linuxOnly, async () => {
  const namespace = fixtureNamespace();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-lease-paths-"));
  const target = path.join(temporary, "target");
  try {
    const initial = await acquireLinuxProcessLease({ namespace, owner: owner("initial") });
    await initial.release();
    const { leasePath } = linuxProcessLeasePaths(namespace);
    fs.rmSync(leasePath);
    fs.writeFileSync(target, "untouched", { mode: 0o600 });
    fs.symlinkSync(target, leasePath);
    await assert.rejects(acquireLinuxProcessLease({ namespace, owner: owner("symlink") }));
    assert.equal(fs.readFileSync(target, "utf8"), "untouched");
    fs.rmSync(leasePath);
    fs.linkSync(target, leasePath);
    await assert.rejects(acquireLinuxProcessLease({ namespace, owner: owner("hardlink") }), /singly linked/);
    fs.rmSync(leasePath);
    fs.writeFileSync(leasePath, "", { mode: 0o644 });
    await assert.rejects(acquireLinuxProcessLease({ namespace, owner: owner("permissions") }), /private/);
  } finally { removeFixtureLease(namespace); fs.rmSync(temporary, { recursive: true, force: true }); }
});

test("Linux Manager migration refuses ambiguous legacy socket paths and releases its new lease", linuxOnly, async () => {
  const namespace = fixtureNamespace();
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-manager-legacy-"));
  const legacyPath = managerInstanceLeaseAddress(namespace);
  try {
    fs.writeFileSync(legacyPath, "foreign fixture", { flag: "wx", mode: 0o600 });
    await assert.rejects(acquireManagerInstanceLock({ rootDir, ownershipNamespace: namespace }), /legacy Linux Manager lease path/);
    assert.equal(fs.readFileSync(legacyPath, "utf8"), "foreign fixture");
    fs.unlinkSync(legacyPath);
    const lease = await acquireManagerInstanceLock({ rootDir, ownershipNamespace: namespace });
    await lease.release();
  } finally {
    fs.rmSync(legacyPath, { force: true });
    removeFixtureLease(`rabiroute-manager:${namespace}`);
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
