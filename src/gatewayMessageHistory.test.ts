import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { Writable } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { createGatewayOutputLineReader, gatewayMessageHistoryLine, parseGatewayMessageHistoryLine, reportGatewayMessageHistory } from "./gatewayMessageHistory.js";
import { gatewayMessageHistoryEvents, localMessageHistoryEvents } from "./manager/gatewayMessageHistoryEvents.js";
import { ManagerEventHub } from "./manager/managerEvents.js";
import type { GatewayDefinition } from "./shared/gatewayConfigModel.js";

const identity = { gatewayId: "route-one", gatewayGenerationId: "generation-one", pid: 1234 };
const definition = { id: identity.gatewayId, agentRoleId: "Local", routeProfiles: [
  { id: "local-profile", agentRoleId: "Second" },
  { id: "remote-profile", agentRoleId: "Foreign", agentRoleDeviceId: "other-pc" }
] } as GatewayDefinition;
const rootDir = path.resolve("message-history-event-fixture");
const events = (line: string, currentChild = true, route = definition) => gatewayMessageHistoryEvents({
  line, expected: identity, currentChild, definition: route, rootDir,
  routeDataDir: path.join(rootDir, "data", "route", route.id),
  roleIdForDefinition: item => item.agentRoleId || "Rabi",
  roleDirectory: role => path.join(rootDir, "data", "roles", role)
});

test("stdout preserves split UTF-8 protocol identities and ordinary READY/log lines", () => {
  const expected = { ...identity, gatewayId: "中文路由" };
  const reader = createGatewayOutputLineReader();
  const lines = [...Buffer.from("ordinary log\r\n" + gatewayMessageHistoryLine(expected) + "\nREADY\n")].flatMap(byte => reader(Buffer.from([byte])));
  assert.equal(lines[0], "ordinary log");
  assert.deepEqual(parseGatewayMessageHistoryLine(lines[1]!, expected), { protocolVersion: 1, ...expected });
  assert.equal(lines[2], "READY");
  assert.deepEqual(reader(Buffer.from("partial")), []);
  assert.deepEqual(reader(Buffer.from(" line\n")), ["partial line"]);
});

test("history hints admit only the exact live Gateway and project local owner roles", () => {
  const line = gatewayMessageHistoryLine(identity);
  assert.deepEqual(events(line), [{ roleId: "Local", gatewayId: "route-one" }, { roleId: "Second", gatewayId: "route-one" }]);
  assert.deepEqual(events(line, false), []);
  assert.deepEqual(events(gatewayMessageHistoryLine({ ...identity, gatewayGenerationId: "retired" })), []);
  assert.deepEqual(events(gatewayMessageHistoryLine({ ...identity, pid: 1235 })), []);
  assert.deepEqual(events(gatewayMessageHistoryLine({ ...identity, gatewayId: "other" })), []);
  assert.deepEqual(events(line, true, { ...definition, agentRoleDeviceId: "other-pc", routeProfiles: [] }), []);
  assert.equal(parseGatewayMessageHistoryLine(line.replace('"protocolVersion":1', '"protocolVersion":2'), identity), null);
  assert.equal(parseGatewayMessageHistoryLine("arbitrary log", identity), null);
  assert.equal(parseGatewayMessageHistoryLine(line.slice(0, -1), identity), null);
  assert.deepEqual(events(line.slice(0, -1) + ',"body":"private text","directory":"private path"}'), events(line));
  if (process.platform === "win32") assert.deepEqual(gatewayMessageHistoryEvents({
    line, expected: identity, currentChild: true, definition, rootDir,
    routeDataDir: path.join(rootDir, "data", "route", identity.gatewayId), roleIdForDefinition: item => item.agentRoleId || "Rabi",
    roleDirectory: role => path.join(rootDir, "DATA", "ROLES", role.toUpperCase())
  }), events(line));
});

test("Manager-local writes admit only the current Route's persisted owner directories", () => {
  const scope = { definition, rootDir, routeDataDir: path.join(rootDir, "data", "route", definition.id),
    roleIdForDefinition: (item: GatewayDefinition) => item.agentRoleId || "Rabi",
    roleDirectory: (role: string) => path.join(rootDir, "data", "roles", role) };
  assert.deepEqual(localMessageHistoryEvents({ ...scope, directory: scope.roleDirectory("Local") }), events(gatewayMessageHistoryLine(identity)));
  assert.deepEqual(localMessageHistoryEvents({ ...scope, directory: scope.roleDirectory("Foreign") }), []);
  assert.deepEqual(localMessageHistoryEvents({ ...scope, directory: path.join(rootDir, "unrelated") }), []);
  assert.deepEqual(localMessageHistoryEvents({ ...scope, directory: scope.roleDirectory("Local"),
    definition: { ...definition, agentRoleDeviceId: "other-pc", routeProfiles: [] } }), []);
});

test("bursts and stdout backpressure retain one hint and disposal releases all listeners", async () => {
  let notify: (directory: string) => void = () => {};
  let stopped = false;
  const chunks: string[] = [], writes: Array<() => void> = [];
  const output = new Writable({ highWaterMark: 1, write(chunk, _encoding, done) { chunks.push(String(chunk)); writes.push(done); } });
  const stop = reportGatewayMessageHistory({ identity, output, subscribe: listener => { notify = listener; return () => { stopped = true; }; } });
  for (let i = 0; i < 100; i++) notify("private/ledger/path");
  await nextTurn();
  assert.equal(chunks.length, 1);
  for (let i = 0; i < 100; i++) notify("private/ledger/path");
  await nextTurn();
  assert.equal(chunks.length, 1);
  writes.shift()!();
  await nextTurn();
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every(chunk => !chunk.includes("private") && parseGatewayMessageHistoryLine(chunk.trim(), identity)));
  stop(); stop();
  assert.equal(stopped, true);
  assert.equal(output.listenerCount("drain"), 0);
  notify("another/path"); writes.shift()!(); await nextTurn();
  assert.equal(chunks.length, 2);
  output.destroy();
});

test("a committed ledger append in a separate Gateway process reaches the existing Manager SSE hub", { timeout: 45000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-gateway-history-test-"));
  const moduleUrl = pathToFileURL(path.resolve("src/gatewayMessageHistory.ts")).href;
  const ledgerUrl = pathToFileURL(path.resolve("src/messageContextStore.ts")).href;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import {reportGatewayMessageHistory} from ${JSON.stringify(moduleUrl)};
    import {appendMessageContextToDir} from ${JSON.stringify(ledgerUrl)};
    const stop=reportGatewayMessageHistory({identity:{gatewayId:'route-one',gatewayGenerationId:'generation-one',pid:process.pid},output:process.stdout});
    console.log('fixture-ready');
    process.stdin.once('data',()=>{
      appendMessageContextToDir(${JSON.stringify(directory)},{time:1,direction:'inbound',adapter:'napcat',text:'synthetic committed message',gatewayId:'route-one',kind:'group',target:'12345',messageId:'1'});
      setImmediate(()=>{stop();process.stdin.destroy();});
    });
  `], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const hub = new ManagerEventHub(), stream = hub.open()!, iterator = stream.frames[Symbol.asyncIterator]();
  t.after(async () => { hub.closeAll(); if (child.exitCode === null) child.kill(); await fs.rm(directory, { recursive: true, force: true }); });
  await iterator.next(); await iterator.next(); // retry and ready are protocol frames, not history changes.
  let failures = "", historyFrames = 0;
  const readLines = createGatewayOutputLineReader();
  const ready = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.stderr.on("data", data => { failures += data.toString(); });
    child.once("exit", code => { if (code) reject(new Error(failures || `fixture exit ${code}`)); });
    child.stdout.on("data", data => {
      for (const line of readLines(data)) {
        if (line === "fixture-ready") { resolve(); continue; }
        for (const event of gatewayMessageHistoryEvents({ line, expected: { ...identity, pid: child.pid! }, currentChild: true,
          definition, rootDir, routeDataDir: path.join(rootDir, "data", "route", identity.gatewayId),
          roleIdForDefinition: item => item.agentRoleId || "Rabi", roleDirectory: role => path.join(rootDir, "data", "roles", role) })) {
          historyFrames++; hub.publish("message_endpoint_history_changed", event);
        }
      }
    });
  });
  await ready;
  assert.equal(historyFrames, 0);
  const frame = iterator.next();
  child.stdin.write("append\n");
  assert.deepEqual((await frame).value, { event: "message_endpoint_history_changed", data: { roleId: "Local", gatewayId: "route-one" } });
  assert.match(await fs.readFile(path.join(directory, "conversation", "current.jsonl"), "utf8"), /synthetic committed message/);
  assert.equal(historyFrames, 2); // one persisted hint projected to its two local personas.
});
