import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkbenchCliCatalog } from "./workbenchCli.mjs";

test("CLI discovery validates each detected executable before probing it", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-cli-"));
  const previousPath = process.env.PATH;
  t.after(async () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await fs.rm(directory, { recursive: true, force: true });
  });
  const files = ["codebuddy", "codex"].map(name =>
    path.join(directory, process.platform === "win32" ? `${name}.exe` : name));
  await Promise.all(files.map(file => fs.writeFile(file, "probe fixture")));
  process.env.PATH = directory;
  const validated = new Set();
  const catalog = createWorkbenchCliCatalog({
    validateExecutable(file) {
      validated.add(file);
      throw new Error("Not on a local execution drive");
    },
  });
  const { providers } = await catalog.list();
  assert.deepEqual(validated, new Set(await Promise.all(files.map(file => fs.realpath(file)))));
  assert.equal(providers.length, files.length);
  assert.ok(providers.every(provider => provider.installed && !provider.ready));
  await assert.rejects(catalog.resolve({ provider: "codex" }, directory, directory), /无法启动/);
});
