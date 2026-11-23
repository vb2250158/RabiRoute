import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { beginRoleWork, roleWorkCount, withRoleLock } from "./roleLifecycle.js";

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "role-storage-lock-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const role = path.join(root, "Example");
  await fs.mkdir(role);
  return { root, role };
}

test("96 tasks on the same role register concurrently despite a legacy lock directory", async t => {
  const { root, role } = await fixture(t);
  const legacy = path.join(root, ".role-state", "locks", "Example");
  await fs.mkdir(legacy, { recursive: true });
  const tasks = await Promise.all(Array.from({ length: 96 }, () => beginRoleWork(role)));
  assert.equal(await roleWorkCount(role), 96);
  await Promise.all(tasks.map(release => release()));
  assert.equal(await roleWorkCount(role), 0);
  assert.ok((await fs.stat(legacy)).isDirectory());
});

test("admission waits for a role write and checks the committed archive state", async t => {
  const { role } = await fixture(t);
  let entered!: () => void;
  let finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const resume = new Promise<void>(resolve => { finish = resolve; });
  const writer = withRoleLock(role, async () => {
    entered();
    await resume;
    await fs.writeFile(path.join(role, "roleMetadata.json"), JSON.stringify({ schemaVersion: 1, revision: 1, archivedAt: new Date().toISOString() }));
  });
  await started;
  const checked = assert.rejects(beginRoleWork(role), { code: "ROLE_ARCHIVED" });
  try {
    await assert.rejects(withRoleLock(role, async () => assert.fail("another writer entered")), { code: "ROLE_BUSY" });
    assert.equal(await roleWorkCount(role), 0);
  } finally {
    finish();
    await writer;
  }
  await checked;
  assert.equal(await roleWorkCount(role), 0);
});

test("terminating a lock owner releases its lock for the next process", { timeout: 15_000 }, async t => {
  const { role } = await fixture(t);
  const moduleUrl = new URL("./roleLifecycle.ts", import.meta.url).href;
  const script = `import { withRoleLock } from ${JSON.stringify(moduleUrl)};
    await withRoleLock(process.argv[1], () => {
      process.send("held");
      return new Promise(() => setInterval(() => {}, 1000));
    });`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, role], {
    stdio: ["ignore", "ignore", "inherit", "ipc"]
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const exited = once(child, "exit");
  const held = await Promise.race([once(child, "message").then(([message]) => message), exited.then(() => "exited")]);
  assert.equal(held, "held");
  try {
    await assert.rejects(withRoleLock(role, async () => assert.fail("child still holds the lock")), { code: "ROLE_BUSY" });
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
  const release = await beginRoleWork(role);
  await release();
  await withRoleLock(role, async () => assert.equal(await roleWorkCount(role), 0));
});
