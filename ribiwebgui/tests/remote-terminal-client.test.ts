import test from "node:test";
import assert from "node:assert/strict";
import { RemoteTerminalClient, remoteShellLabel } from "../src/remoteTerminalClient.js";

test("terminal labels preserve each advertised platform shell", () => {
  assert.deepEqual(["cmd", "powershell", "zsh", "bash", "sh", "custom"].map(remoteShellLabel),
    ["CMD", "PowerShell", "Zsh", "Bash", "Shell", "custom"]);
});

test("terminal output decodes split Unicode/SSE frames without polling or automatic replay", async () => {
  const requests: string[] = [];
  const encoder = new TextEncoder();
  const bytes = encoder.encode('id: 1\ndata: {"sequence":1,"type":"output","data":"中文"}\n\nid: 2\ndata: {"sequence":2,"type":"exit","exitCode":0}\n\n');
  const fetcher = (async (url: string) => {
    requests.push(url);
    return new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }));
  }) as typeof fetch;
  const client = new RemoteTerminalClient("node-a", "fixture", fetcher);
  const events: unknown[] = [];
  await client.events("fixture-terminal", new AbortController().signal, event => events.push(event));
  assert.deepEqual(events, [{ sequence: 1, type: "output", data: "中文" }, { sequence: 2, type: "exit", exitCode: 0 }]);
  assert.equal(requests.length, 1);
});

test("a failed mutation does not resend command input", async () => {
  let calls = 0;
  const client = new RemoteTerminalClient("node", "fixture", (async () => { calls++; throw new Error("connection lost"); }) as typeof fetch);
  await assert.rejects(client.request({ action: "input", terminalId: "fixture", sequence: 1, data: "echo fixture\r" }), /connection lost/);
  assert.equal(calls, 1);
});

test("terminal commands and output stay on the selected connected host", async () => {
  const requests: string[] = [];
  const fetcher = (async (url: string) => {
    requests.push(url);
    return url.endsWith("/events") ? new Response("data: {\"sequence\":1,\"type\":\"exit\",\"exitCode\":0}\n\n")
      : new Response(JSON.stringify({ code: 0, data: { sessions: [] } }));
  }) as typeof fetch;
  const client = new RemoteTerminalClient("instance-b", "fixture", fetcher, "peer b");
  await client.request();
  await client.request({ action: "input", terminalId: "terminal-b", sequence: 1, data: "echo target\r" });
  const events: unknown[] = [];
  await client.events("terminal-b", new AbortController().signal, event => events.push(event));
  const base = "/api/rabilink/peer/http/peer%20b/manager/api/lan-agent/instances/instance-b/terminals";
  assert.deepEqual(requests, [base, base, `${base}/terminal-b/events`]);
  assert.deepEqual(events, [{ sequence: 1, type: "exit", exitCode: 0 }]);
});

test("the browser fetch receiver is preserved when the client stores it", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async function () { assert.equal(this, globalThis); return new Response(JSON.stringify({ code: 0, data: { sessions: [] } })); } as typeof fetch;
  try { assert.deepEqual(await new RemoteTerminalClient("node", "fixture").request(), { sessions: [] }); }
  finally { globalThis.fetch = original; }
});
