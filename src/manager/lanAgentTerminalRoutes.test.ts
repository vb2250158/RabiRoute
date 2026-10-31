import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { LanAgentRegistry } from "./lanAgentRegistry.js";
import { handleLanAgentApiFixture as handleLanAgentApi } from "./lanAgentRouteTestSupport.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { createHash } from "node:crypto";
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check: () => boolean) { const end = Date.now() + 20000; while(Date.now() < end){if(check())return;await delay(30);}throw new Error("Terminal integration timed out."); }

test("authenticated HTTP/WS terminal lifecycle streams a real Windows shell and denies an anonymous caller", { skip: process.platform !== "win32" }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-terminal-http-"));
  const token = "fixture-token";
  const registry = new LanAgentRegistry({ statePath: path.join(root, "registry.json") });
  const server = http.createServer((request, response) => {
    // Test-only stand-in for an already verified host Agent ingress.
    if (request.headers["x-fixture-host-agent"] === "verified") markAuthenticatedConnectionRequest(request);
    const handled = handleLanAgentApi(request, new URL(request.url!, "http://fixture.invalid"), response, {
      registry, isManagementRequestAuthorized: input => input.headers["x-rabiroute-webgui-token"] === token,
      isReleaseRequestAuthorized: () => false, releases: {} as never,
      readJsonBody: async input => { let value = ""; for await (const chunk of input) value += chunk; return JSON.parse(value); },
      jsonResponse: (output, code, body) => { output.statusCode = code; output.setHeader("content-type", "application/json"); output.end(JSON.stringify(body)); }
    });
    if (!handled) { response.statusCode = 404; response.end(); }
  });
  const detach = registry.attach(server, { getToken: () => token, enabled: () => true });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const socket = new WebSocket(`${base.replace("http", "ws")}/api/lan-agent/connect`);
  const module = await import(pathToFileURL(path.resolve("apps/rabi-agent/rabi-agent.mjs")).href);
  const config = { nodeId: "fixture-node", nodeCredential: token, managerUrl: base, defaultWorkspace: root, agents: [], autoUpdate: false };
  const configPath = path.join(root,"client.json"); fs.writeFileSync(configPath,JSON.stringify(config));
  const runtime = new module.__test.RabiAgentRuntime(config,configPath); runtime.socket = socket;
  runtime.taskQueue = new Promise(() => undefined); // A blocked Agent queue cannot block computer I/O.
  runtime.desktop.connect = () => { throw new Error("No Agent backend may start in this fixture."); };
  let ready = false;
  socket.on("open", () => socket.send(JSON.stringify({ type: "authenticate", token })));
  socket.on("message", raw => {
    const message = JSON.parse(raw.toString());
    runtime.handleManagerMessage(raw.toString());
    if (message.type === "connected") ready = true;
  });
  const streamAbort = new AbortController();
  t.after(async () => {
    streamAbort.abort(); runtime.stop(); await runtime.terminals.stop(); socket.close(); detach();server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await waitFor(() => ready);
  const url = `${base}/api/lan-agent/instances/fixture-node/terminals`;
  assert.equal((await fetch(url)).status, 401);
  const headers = { "content-type": "application/json", "x-rabiroute-webgui-token": token };
  const hostHeaders = { "content-type": "application/json", "x-fixture-host-agent": "verified" };
  assert.equal((await fetch(url,{headers:hostHeaders})).status,200);
  assert.deepEqual(registry.listNodes()[0]!.agents,[]);
  const post = async (body: unknown) => {
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const receipt = await response.json(); assert.equal(receipt.code, 0, JSON.stringify(receipt)); return receipt.data;
  };
  const terminalId = randomUUID();
  const opened = await post({ action: "open", terminalId, shell: "cmd" });
  assert.equal(opened.state, "running");
  assert.equal((await (await fetch(url, { headers })).json()).data.sessions.length, 1);
  const output = await fetch(`${url}/${terminalId}/events`, { headers, signal: streamAbort.signal });
  assert.equal(output.status, 200);
  const reader = output.body!.getReader(); const decoder = new TextDecoder(); let transcript = "";
  const reading = (async () => { try { while(true) { const chunk = await reader.read(); if(chunk.done)break; transcript += decoder.decode(chunk.value); } } catch { } })();
  await post({ action: "input", terminalId, sequence: 1, data: "echo HTTP_TERM_921\r" });
  await waitFor(() => transcript.includes("HTTP_TERM_921"));
  const read = await (await fetch(`${url}/${terminalId}?after=0&waitMs=1000`,{headers:hostHeaders})).json();
  assert.equal(read.code,0); assert.match(read.data.outputEvents.map((item:{data?:string})=>item.data||"").join(""),/HTTP_TERM_921/);
  const computerUrl = `${base}/api/lan-agent/instances/fixture-node/computer`;
  assert.equal((await fetch(computerUrl,{method:"POST",headers:{"content-type":"application/json"},body:'{"action":"windows.list"}'})).status,401);
  const computer = async (body:unknown) => {
    const receipt = await (await fetch(computerUrl,{method:"POST",headers:hostHeaders,body:JSON.stringify(body)})).json();
    assert.equal(receipt.code,0,JSON.stringify(receipt));return receipt.data;
  };
  const bytes = Buffer.from([0,255,128,1,13,10]), uploadId = randomUUID(), target = path.join(root,"remote-file.bin");
  const hash = createHash("sha256").update(bytes).digest("hex");
  await computer({action:"upload.begin",uploadId,path:target,size:bytes.length,sha256:hash});
  await computer({action:"upload.write",uploadId,offset:0,data:bytes.toString("base64"),sha256:hash});
  await computer({action:"upload.commit",uploadId});
  const metadata = await computer({action:"file.stat",path:target});
  const downloaded = await computer({action:"file.read",path:target,version:metadata.version,offset:0});
  assert.deepEqual(Buffer.from(downloaded.data,"base64"),bytes);
  const windows = await computer({action:"windows.list",query:"RabiFixtureNoSuchWindow"});assert.deepEqual(windows.windows,[]);
  const capture = await computer({action:"screen.capture",maxWidth:320});assert.equal(capture.mimeType,"image/png");
  await post({ action: "close", terminalId }); await reading;
  assert.match(transcript, /"type":"exit"/);
  assert.equal((await post({ action: "get", terminalId })).state, "exited");
});
