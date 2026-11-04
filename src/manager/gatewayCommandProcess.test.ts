import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnGatewayCommandProcess } from "./gatewayCommandProcess.js";
import { gatewayRouteSnapshotRevision } from "../shared/gatewayRouteSnapshot.js";

test("one-shot child receives the admitted Route and retains it through actual close", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-command-snapshot-"));
  const definition = { id: "original-route", gatewayPort: 0, workbuddySessionId: "original-task", workbuddyCwd: "/original" };
  const expectedRevision = gatewayRouteSnapshotRevision(definition);
  const child = spawnGatewayCommandProcess({
    definition, snapshotDirectory: directory, cwd: directory, command: process.execPath,
    args: ["--input-type=module", "-e", `import fs from 'node:fs';
      const filename=process.env.RABIROUTE_ROUTE_SNAPSHOT_PATH;
      console.log(JSON.stringify({filename,revision:process.env.RABIROUTE_ROUTE_REVISION,definition:JSON.parse(fs.readFileSync(filename,'utf8'))}));
      process.stdin.resume();`],
    environment: () => ({ ...process.env, RABIROUTE_ROUTE_SNAPSHOT_PATH: "/wrong-mutable-path", RABIROUTE_ROUTE_REVISION: "wrong" }),
    cleanupError: error => { throw error; }
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => {
    child.stdin.end();
    await closed;
    await fs.rm(directory, { recursive: true, force: true });
  });
  definition.workbuddySessionId = "later-task";
  definition.workbuddyCwd = "/later";
  let output = "";
  const line = await new Promise<string>((resolve, reject) => {
    child.stdout.on("data", data => { output += String(data); if (output.includes("\n")) resolve(output.split("\n")[0]!); });
    child.once("error", reject);
  });
  const observed = JSON.parse(line);
  assert.equal(observed.definition.workbuddySessionId, "original-task");
  assert.equal(observed.definition.workbuddyCwd, "/original");
  assert.equal(observed.revision, expectedRevision);
  await fs.access(observed.filename);
  child.stdin.end();
  assert.deepEqual(await closed, { code: 0, signal: null });
  await assert.rejects(fs.access(observed.filename), { code: "ENOENT" });
});

test("failed spawn releases only its owned boot snapshot", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-command-failed-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "preserve.txt"), "original");
  const child = spawnGatewayCommandProcess({
    definition: { id: "original-route", gatewayPort: 0 }, snapshotDirectory: directory, cwd: directory,
    command: path.join(directory, "missing-executable"), args: [], environment: () => process.env,
    cleanupError: error => { throw error; }
  });
  let failure: unknown;
  child.once("error", error => { failure = error; });
  await new Promise<void>(resolve => child.once("close", () => resolve()));
  assert.ok(failure);
  assert.deepEqual(await fs.readdir(directory), ["preserve.txt"]);
});
