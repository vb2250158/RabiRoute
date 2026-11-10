import { normalizeComputerSettings, patchComputerSettings } from "../../apps/rabi-agent/lib/computer-control-contract.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ManagerLocalComputer } from "./managerLocalComputer.js";
import { LanAgentRegistry } from "./lanAgentRegistry.js";

async function fixture(t: test.TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "manager-local-computer-"));
  const registry = new LanAgentRegistry({ statePath: path.join(directory, "registry.json"),
    createLocalComputer: (_instanceId, emit) => new ManagerLocalComputer({ stateDirectory: path.join(directory, "computer"), defaultCwd: directory, emit }) });
  const owner = registry.localComputer!;
  t.after(async () => { await owner.stop(); registry.terminals.disconnect(registry.localInstanceId); registry.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const computer = (input: Record<string, unknown>, guard?: () => void) => registry.manageAgent(registry.localInstanceId, "computer", input, undefined, guard);
  return { directory, registry, owner, computer };
}

test("host with no connector or Agent exposes real platform capabilities and chunked file operations", async t => {
  const f = await fixture(t), [instance] = f.registry.listInstances();
  assert.equal(instance.local, true); assert.deepEqual(instance.agents, []); assert.deepEqual(f.registry.listNodes(), []);
  assert.ok(instance.terminalShells?.length);
  const tracking = await fs.access(new URL("../../apps/rabi-agent/dist/native/RabiAgent.Computer.Tracking.dll", import.meta.url)).then(() => true, () => false);
  assert.deepEqual(instance.computerCapabilities, ["files", ...(process.platform === "win32" ? ["windows", "screenshots", "input", "annotation", ...(tracking ? ["tracking"] : [])] : [])]);
  const bytes = Buffer.alloc(65_537, 211), uploadId = randomUUID(), target = path.join(f.directory, "roundtrip.bin");
  const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
  await f.computer({ action: "upload.begin", uploadId, path: target, size: bytes.length, sha256: sha256(bytes) });
  for (let offset = 0; offset < bytes.length; offset += 65_536) {
    const chunk = bytes.subarray(offset, offset + 65_536);
    await f.computer({ action: "upload.write", uploadId, offset, data: chunk.toString("base64"), sha256: sha256(chunk) });
  }
  await f.computer({ action: "upload.commit", uploadId });
  const metadata = await f.computer({ action: "file.stat", path: target }) as { version: string; size: number };
  const downloaded: Buffer[] = [];
  for (let offset = 0; offset < metadata.size;) {
    const result = await f.computer({ action: "file.read", path: target, version: metadata.version, offset }) as { data: string; sha256: string; nextOffset: number };
    const chunk = Buffer.from(result.data, "base64"); assert.equal(sha256(chunk), result.sha256); downloaded.push(chunk); offset = result.nextOffset;
  }
  assert.deepEqual(Buffer.concat(downloaded), bytes);
  const revoked = new Error("fixture original admission revoked");
  await assert.rejects(f.computer({ action: "file.stat", path: target }, () => { throw revoked; }), error => error === revoked);
  assert.equal((await f.computer({ action: "upload.status", uploadId }) as { state: string }).state, "committed");
});

test("host stop cleans incomplete upload under its original identity and refuses subsequent work", async t => {
  const f = await fixture(t), uploadId = randomUUID(), target = path.join(f.directory, "incomplete.bin");
  await f.computer({ action: "upload.begin", uploadId, path: target, size: 1, sha256: createHash("sha256").update("x").digest("hex") });
  const stopping = f.owner.stop(); assert.equal(stopping, f.owner.stop()); await stopping;
  await assert.rejects(fs.stat(path.join(f.directory, `.rabi-upload-${uploadId}.tmp`)), { code: "ENOENT" });
  await assert.rejects(f.computer({ action: "file.stat", path: target }), /stopping/);
  const restored = new ManagerLocalComputer({ stateDirectory: path.join(f.directory, "computer"), emit: () => {} });
  t.after(() => restored.stop());
  assert.equal((await restored.execute("computer", { action: "upload.status", uploadId }) as { state: string }).state, "aborted");
});

test("host terminal reuses native execution, ordered input and Registry output without a connector", async t => {
  const f = await fixture(t), id = f.registry.localInstanceId, terminalId = randomUUID();
  const shell = f.owner.terminalShells[0]!;
  const opened = await f.registry.terminals.execute(id, { action: "open", terminalId, shell }) as { pid: number; state: string };
  assert.equal(opened.state, "running");
  const command = shell === "cmd" ? "set /a 700+29\r" : shell === "powershell"
    ? "[Console]::WriteLine(700+29)\r" : "printf '%s\\n' $((700+29))\r";
  const input = { action: "input", terminalId, sequence: 1, data: command };
  await f.registry.terminals.execute(id, input); await f.registry.terminals.execute(id, input);
  let output = "", after = 0;
  const deadline = Date.now() + 15_000;
  while (!output.includes("729") && Date.now() < deadline) {
    const read = await f.registry.terminals.read(id, terminalId, after, 1000) as { outputEvents: { data?: string }[]; nextOutputSequence: number };
    output += read.outputEvents.map(event => event.data ?? "").join(""); after = read.nextOutputSequence;
  }
  assert.match(output, /729/);
  const state = await f.registry.terminals.execute(id, { action: "get", terminalId }) as { nextInputSequence: number };
  assert.equal(state.nextInputSequence, 2);
  await f.owner.stop();
  assert.throws(() => process.kill(opened.pid, 0));
});

test("disabled terminal feature retains metadata and close but rejects new input without output leakage",async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),"terminal-feature-recovery-"));let settings=normalizeComputerSettings();
 const owner=new ManagerLocalComputer({stateDirectory:directory,getSettings:()=>settings,emit:()=>{}});t.after(async()=>{await owner.stop();await fs.rm(directory,{recursive:true,force:true});});
 const terminalId=randomUUID(),shell=owner.terminalShells[0]!;
 await owner.execute("terminal",{action:"open",terminalId,shell});settings=patchComputerSettings(settings,{enabled:false,features:{terminal:false}});
 const listed=await owner.execute("terminal",{action:"list"}) as {sessions:Record<string,unknown>[]};assert.equal(listed.sessions[0]!.terminalId,terminalId);assert.equal("outputEvents" in listed.sessions[0]!,false);
 const snapshot=await owner.execute("terminal",{action:"get",terminalId}) as Record<string,unknown>;assert.equal(snapshot.terminalId,terminalId);assert.equal("data" in snapshot,false);assert.equal("outputEvents" in snapshot,false);
 await assert.rejects(owner.execute("terminal",{action:"input",terminalId,sequence:1,data:"must not run"}),{code:"COMPUTER_FEATURE_DISABLED"});
 assert.equal((await owner.execute("terminal",{action:"close",terminalId}) as {state:string}).state,"exited");
});
