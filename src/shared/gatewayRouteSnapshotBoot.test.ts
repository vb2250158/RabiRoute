import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readGatewayRouteBootSnapshot, writeGatewayRouteBootSnapshot } from "./gatewayRouteSnapshotBoot.js";

test("a real child reads and validates a large immutable Route through a small path environment value", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-route-boot-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const definition = { id: "route-large", gatewayPort: 8790, contextTemplate: "中文prompt".repeat(15000), targets: Array.from({ length: 200 }, (_, i) => ({ id: `target-${i}`, text: "target-context".repeat(50) })) };
  const boot = writeGatewayRouteBootSnapshot(directory, "test-generation", definition);
  t.after(() => boot.dispose());
  assert.ok((await fs.stat(boot.filename)).size > 32767);
  const moduleUrl = new URL("./gatewayRouteSnapshotBoot.ts", import.meta.url).href;
  const source = `import {readGatewayRouteBootSnapshot} from ${JSON.stringify(moduleUrl)}; const value=readGatewayRouteBootSnapshot(process.env.RABIROUTE_ROUTE_SNAPSHOT_PATH,process.env.RABIROUTE_ROUTE_REVISION,'route-large'); console.log(JSON.stringify({length:value.contextTemplate.length,frozen:Object.isFrozen(value.targets[0]),pid:process.pid}));`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { env: { ...process.env, RABIROUTE_ROUTE_SNAPSHOT_PATH: boot.filename, RABIROUTE_ROUTE_REVISION: boot.revision }, windowsHide: true });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, 0, stderr);
  const result = JSON.parse(stdout);
  assert.equal(result.length, definition.contextTemplate.length);
  assert.equal(result.frozen, true);
  assert.equal(result.pid, child.pid);
  assert.throws(() => readGatewayRouteBootSnapshot(boot.filename, "a".repeat(64), definition.id));
  assert.throws(() => readGatewayRouteBootSnapshot(boot.filename, boot.revision, "another-route"));
});

test("a malformed private boot snapshot reports a fixed child diagnostic without exposing bytes or changing the file", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-route-boot-private-"));
  t.after(async () => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith("rabi-route-boot-private-")); await fs.rm(directory, { recursive: true, force: true }); });
  const filename = path.join(directory, "generation.json"), raw = "private-boot-credential-sentinel";
  await fs.writeFile(filename, raw);
  const moduleUrl = new URL("./gatewayRouteSnapshotBoot.ts", import.meta.url).href;
  const source = `import {readGatewayRouteBootSnapshot} from ${JSON.stringify(moduleUrl)}; readGatewayRouteBootSnapshot(process.env.RABIROUTE_ROUTE_SNAPSHOT_PATH,process.env.RABIROUTE_ROUTE_REVISION,'private-route');`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { env: { ...process.env, RABIROUTE_ROUTE_SNAPSHOT_PATH: filename, RABIROUTE_ROUTE_REVISION: "a".repeat(64) }, windowsHide: true });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.notEqual(code, 0); assert.equal(stdout, "");
  assert.match(stderr, /Gateway boot Route snapshot is invalid JSON\./);
  assert.equal(stderr.includes(raw), false);
  assert.equal(await fs.readFile(filename, "utf8"), raw);
});
