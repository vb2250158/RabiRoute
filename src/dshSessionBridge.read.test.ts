import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readDshPrimaryBinding, readDshPrimaryBindingAsync } from "./dshSessionBridge.js";

const settings = { dshSessionId: "session-00000000-0000-0000-0000-000000000001", dshSessionName: "existing",
  dshCwd: "/workspace", dshBaseUrl: "http://127.0.0.1:12345" };

test("async binding reads preserve the existing owner and config parsing", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "binding-read-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "adapterConfig.json");
  fs.writeFileSync(file, JSON.stringify(settings));
  assert.deepEqual(await readDshPrimaryBindingAsync(file), readDshPrimaryBinding(file));
});

test("slow binding storage yields the event loop instead of blocking health work", async t => {
  let release!: (value: string) => void;
  const gate = new Promise<string>(resolve => { release = resolve; });
  t.mock.method(fs.promises, "readFile", () => gate);
  t.mock.method(fs, "readFileSync", () => { throw new Error("synchronous shared read"); });
  const binding = readDshPrimaryBindingAsync("shared-adapter-config");
  await new Promise(resolve => setImmediate(resolve));
  release(JSON.stringify(settings));
  assert.equal((await binding)?.sessionId, settings.dshSessionId);
});

test("missing bindings remain absent, while storage failures are not misreported as unbound", async t => {
  t.mock.method(fs.promises, "readFile", async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); });
  assert.equal(await readDshPrimaryBindingAsync("missing"), null);
  t.mock.method(fs.promises, "readFile", async () => { throw Object.assign(new Error("private path"), { code: "EIO" }); });
  await assert.rejects(readDshPrimaryBindingAsync("shared"), error => error instanceof Error
    && error.message.includes("temporarily unreadable") && !error.message.includes("private path"));
});
