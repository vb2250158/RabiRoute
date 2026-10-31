import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { Readable, PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { runManagerCommand } from "../lib/manager-cli.mjs";

async function fixture(t, framing = "json") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-cli-ws-"));
  const credential = "fixture-cli-private-credential", meta = { applicationGenerationId: "generation", managerInstanceId: "manager", health: { live: true, requiredReady: true, state: "healthy" } };
  const schema = { type: "object", required: ["type"], properties: { type: { type: "string" } }, additionalProperties: true };
  const websocket = framing === "passthrough" ? { framing, protocol: "future", wire: { dataFrameBytes: 12000, streamWindowBytes: 65536, maxConcurrentStreams: 16 } }
    : { framing, protocol: "future", maxMessageBytes: 65536, maxBufferedBytes: 131072, ...(framing === "json" ? { incomingSchema: schema, outgoingSchema: schema } : {}) };
  const contract = { operationId: "future.socket", aliases: ["old.socket"], contractVersion: "1.0.0", method: "GET", pathTemplate: "/future/:channel", transport: "websocket", request: { body: { kind: "none" } }, websocket };
  const state = { upgrades: [], messages: [], meta, contract };
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/meta") response.end(JSON.stringify(meta));
    else if (request.url === "/api/agent/help") response.end(JSON.stringify({ code: 0, data: { schemaVersion: "2", ...meta,
      pluginGenerationId: "plugins", catalogRevision: 1, catalogDigest: "sha256:" + "a".repeat(64), operations: [{ id: contract.operationId, contractDigest: "sha256:" + "b".repeat(64), contract }] } }));
    else response.writeHead(404).end("{}");
  });
  const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  server.on("upgrade", (request, socket, head) => {
    state.upgrades.push({ path: request.url, headers: request.headers });
    sockets.handleUpgrade(request, socket, head, channel => sockets.emit("connection", channel));
  });
  sockets.on("connection", channel => { state.channel = channel; state.onConnect?.(channel); channel.on("message", (bytes, binary) => { state.messages.push({ bytes: Buffer.from(bytes), binary }); state.onMessage?.(channel, bytes, binary); }); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const configPath = path.join(root, "config.json"), outputPath = path.join(root, "frames.jsonl");
  await fs.writeFile(configPath, JSON.stringify({ managerUrl: `http://127.0.0.1:${server.address().port}`, nodeCredential: credential }));
  t.after(async () => { for (const channel of sockets.clients) channel.terminate(); await new Promise(r => sockets.close(r)); server.closeAllConnections(); await new Promise(r => server.close(r));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const args = ["--operation", "old.socket", "--websocket", "--output", outputPath, "--agent-type", "dsh", "--id", "full-source-id", "--path-params", '{"channel":"one / two"}', "--query", '{"tag":["a","b"]}', "--timeout-ms", "5000"];
  return Object.assign(state, { root, outputPath, configPath, credential, args,
    run: (extra = [], inputStream) => runManagerCommand([...args, ...extra], configPath, { inputStream }),
    records: async () => (await fs.readFile(outputPath, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) });
}

test("CLI resolves a future WebSocket alias and captures every JSON frame before normal remote EOF", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  f.onMessage = channel => { for (let i = 0; i < 3; i++) channel.send(JSON.stringify({ type: "result", i }), { binary: i === 1 }); channel.close(1000, "complete"); };
  const result = await f.run(["--frames-stdin"], Readable.from([JSON.stringify({ type: "json", data: { type: "request" } }) + "\n"]));
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.operationId, "future.socket"); assert.equal(result.framesSent, 1); assert.equal(result.framesReceived, 3);
  assert.equal(result.businessOutcome, "not-evaluated"); assert.equal(result.noReplay, true); assert.equal(result.outputCommitted, true);
  assert.deepEqual(await f.records(), [0, 1, 2].map(i => ({ type: "json", data: { type: "result", i } })));
  assert.equal(f.upgrades[0].path, "/future/one%20%2F%20two?tag=a&tag=b");
  assert.equal(f.upgrades[0].headers.authorization, "Bearer " + f.credential); assert.equal(f.upgrades[0].headers["x-rabiroute-session-id"], "full-source-id");
  assert.equal(result.sha256, createHash("sha256").update(await fs.readFile(f.outputPath)).digest("hex"));
});

test("opaque CLI frames preserve text, binary and subprotocols while input EOF does not close the peer", { timeout: 10000 }, async t => {
  const f = await fixture(t, "passthrough"), binary = Buffer.from([0, 255, 128, 10]); let count = 0;
  f.onMessage = (channel, bytes, isBinary) => { channel.send(bytes, { binary: isBinary }); if (++count === 2) channel.close(1000); };
  const source = Readable.from([JSON.stringify({ type: "text", data: "text\n汉字" }) + "\n" + JSON.stringify({ type: "binary", data: binary.toString("base64") }) + "\n"]);
  const result = await f.run(["--frames-stdin", "--ws-protocols", '["future.v1"]'], source);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.framesSent, 2); assert.equal(f.messages[0].binary, false); assert.equal(f.messages[1].binary, true);
  assert.deepEqual(await f.records(), [{ type: "text", data: "text\n汉字" }, { type: "binary", data: binary.toString("base64") }]);
  assert.equal(f.channel.protocol, "future.v1");
});

test("remote EOF interrupts a pending stdin read and releases both owned streams", { timeout: 10000 }, async t => {
  const f = await fixture(t), input = new PassThrough();
  f.onMessage = channel => { channel.send(JSON.stringify({ type: "done" })); channel.close(1000); };
  input.write(JSON.stringify({ type: "json", data: { type: "request" } }) + "\n");
  const result = await f.run(["--frames-stdin"], input); assert.equal(result.ok, true); assert.equal(result.inputComplete, false); assert.equal(input.destroyed, true);
});

test("an explicit close frame ends capture and releases stdin without requiring input EOF", { timeout: 10000 }, async t => {
  const f = await fixture(t), input = new PassThrough(); input.write('{"type":"close","code":1000,"reason":"done"}\n');
  const result = await f.run(["--frames-stdin"], input);
  assert.equal(result.ok, true); assert.equal(result.inputComplete, true); assert.equal(result.framesSent, 0); assert.equal(input.destroyed, true);
  assert.equal(await fs.readFile(f.outputPath, "utf8"), "");
});

test("existing output is never overwritten and incompatible CLI options never open an upgrade", { timeout: 10000 }, async t => {
  const f = await fixture(t); await fs.writeFile(f.outputPath, "original");
  const result = await f.run(); assert.equal(result.ok, false); assert.equal(result.transportError, "OUTPUT_EXISTS"); assert.equal(f.upgrades.length, 0);
  assert.equal(await fs.readFile(f.outputPath, "utf8"), "original");
  await assert.rejects(f.run(["--body-stdin"]), /without HTTP bodies/); assert.equal(f.upgrades.length, 0);
});

test("invalid input and output capacity fail without committing a partial capture or replaying frames", { timeout: 10000 }, async t => {
  for (const invalid of [true, false]) {
    const f = await fixture(t); f.onMessage = channel => channel.send(JSON.stringify({ type: "reply", text: "x".repeat(1000) }));
    const input = Readable.from([invalid ? '{"type":"binary","data":"not base64"}\n' : '{"type":"json","data":{"type":"request"}}\n']);
    const result = await f.run(["--frames-stdin", ...(invalid ? [] : ["--ws-max-output-bytes", "30"])], input);
    assert.equal(result.ok, false); assert.equal(result.outputCommitted, false); assert.equal(result.noReplay, true); assert.equal(f.upgrades.length, 1, JSON.stringify(result));
    assert.deepEqual((await fs.readdir(f.root)).sort(), ["config.json"]);
  }
});

test("Manager generation changes after application frames prevent output publication", { timeout: 10000 }, async t => {
  const f = await fixture(t); f.onMessage = channel => { channel.send(JSON.stringify({ type: "reply" })); f.meta.applicationGenerationId = "new-generation"; channel.close(1000); };
  const result = await f.run(["--frames-stdin"], Readable.from(['{"type":"json","data":{"type":"request"}}\n']));
  assert.equal(result.ok, false); assert.equal(result.outputCommitted, false); assert.equal(result.uncertain, true); assert.equal(f.upgrades.length, 1);
  assert.deepEqual((await fs.readdir(f.root)).sort(), ["config.json"]);
});

test("deadline cancellation closes the socket and pending stdin without publishing or replaying", { timeout: 10000 }, async t => {
  const f = await fixture(t), input = new PassThrough();
  input.write('{"type":"json","data":{"type":"request"}}\n');
  const args = f.args.slice(); args[args.indexOf("--timeout-ms") + 1] = "500";
  const before = process.listenerCount("SIGINT");
  const result = await runManagerCommand([...args, "--frames-stdin"], f.configPath, { inputStream: input });
  assert.equal(result.ok, false); assert.equal(result.noReplay, true); assert.equal(result.outputCommitted, false);
  assert.equal(input.destroyed, true); assert.equal(f.upgrades.length, 1); assert.equal(f.messages.length, 1);
  assert.equal(process.listenerCount("SIGINT"), before); assert.deepEqual((await fs.readdir(f.root)).sort(), ["config.json"]);
});

test("reflected transport credentials are redacted in JSON values and keys; binary reflections fail", { timeout: 10000 }, async t => {
  for (const binary of [false, true]) {
    const f = await fixture(t, binary ? "passthrough" : "json");
    f.onMessage = channel => { channel.send(binary ? Buffer.from(f.credential) : JSON.stringify({ type: "reply", [f.credential]: f.credential })); channel.close(1000); };
    const result = await f.run(["--frames-stdin"], Readable.from(['{"type":"json","data":{"type":"request"}}\n']));
    assert.equal(JSON.stringify(result).includes(f.credential), false);
    if (binary) { assert.equal(result.ok, false); assert.equal(result.outputCommitted, false); assert.equal(result.transportError, "CREDENTIAL_REFLECTION"); }
    else { assert.equal(result.ok, true); const text = await fs.readFile(f.outputPath, "utf8"); assert.equal(text.includes(f.credential), false); assert.match(text, /REDACTED/); }
  }
});

test("a destination created during capture is preserved and the private partial file is removed", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  f.onMessage = channel => { void fs.writeFile(f.outputPath, "concurrent owner").then(() => { channel.send('{"type":"reply"}'); channel.close(1000); }); };
  const result = await f.run(["--frames-stdin"], Readable.from(['{"type":"json","data":{"type":"request"}}\n']));
  assert.equal(result.ok, false); assert.equal(await fs.readFile(f.outputPath, "utf8"), "concurrent owner");
  assert.deepEqual((await fs.readdir(f.root)).sort(), ["config.json", "frames.jsonl"]);
});

test("capture cancellation joins an accepted disk write and performs no later partial write", { timeout: 10000 }, async t => {
  const f = await fixture(t), probePath = path.join(f.root, "probe.tmp"), handle = await fs.open(probePath, "wx");
  const prototype = Object.getPrototypeOf(handle), original = prototype.write; await handle.close(); await fs.unlink(probePath);
  let release, started; const held = new Promise(resolve => { release = resolve; }), writing = new Promise(resolve => { started = resolve; });
  let writes = 0;
  t.mock.method(prototype, "write", async function(buffer, offset, length, position) {
    writes++; if (writes === 1) { started(); await held; return original.call(this, buffer, offset, 1, position); }
    return original.call(this, buffer, offset, length, position);
  });
  f.onMessage = channel => channel.send('{"type":"reply","text":"pending write"}');
  const args = f.args.slice(); args[args.indexOf("--timeout-ms") + 1] = "500";
  let completed = false;
  const command = runManagerCommand([...args, "--frames-stdin"], f.configPath, { inputStream: Readable.from(['{"type":"json","data":{"type":"request"}}\n']) }).then(result => { completed = true; return result; });
  try { await writing; await new Promise(resolve => setTimeout(resolve, 600)); assert.equal(completed, false); }
  finally { release(); }
  const result = await command; assert.equal(result.ok, false); assert.equal(writes, 1); assert.equal(result.outputCommitted, false);
  assert.deepEqual((await fs.readdir(f.root)).sort(), ["config.json"]);
});

test("the real CLI entry reads JSONL stdin and prints only its redacted receipt", { timeout: 10000 }, async t => {
  const f = await fixture(t); f.onMessage = channel => { channel.send('{"type":"actual-entry"}'); channel.close(1000); };
  const entry = fileURLToPath(new URL("../rabi-agent.mjs", import.meta.url));
  const child = spawn(process.execPath, [entry, ...f.args, "--frames-stdin", "--config", f.configPath], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = "", stderr = ""; child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; });
  const done = once(child, "exit"); child.stdin.end('{"type":"json","data":{"type":"request"}}\n');
  const [code] = await done; assert.equal(code, 0, stderr);
  const result = JSON.parse(stdout); assert.equal(result.ok, true); assert.equal(result.framesReceived, 1); assert.equal(stdout.includes(f.credential), false);
  assert.deepEqual(await f.records(), [{ type: "json", data: { type: "actual-entry" } }]);
});
