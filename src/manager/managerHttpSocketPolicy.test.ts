import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import test, { type TestContext } from "node:test";

function actualManagerLimits() {
  const source = fs.readFileSync(path.resolve("src/manager/controlPlaneRoutes.ts"), "utf8");
  const match = /const managerHttpLimits = (\{[\s\S]*?\n\}) as const;/.exec(source);
  assert.ok(match, "Use the actual shared Manager HTTP owner");
  return new Function("getTimeoutMs", `return (${match[1]});`)((_key: string, fallback: number) => fallback) as {
    maxRequestsPerSocket: number; requestTimeoutMs: number; headersTimeoutMs: number; keepAliveTimeoutMs: number;
  };
}

async function fixture(t: TestContext, limit: number) {
  let served = 0, dropped = 0, connections = 0;
  const sockets = new Set<net.Socket>();
  const server = http.createServer((_request, response) => { served++; response.writeHead(200, { "content-type": "application/json", "content-length": "2" }); response.end("{}"); });
  server.maxRequestsPerSocket = limit;
  const limits = actualManagerLimits();
  server.requestTimeout = limits.requestTimeoutMs; server.headersTimeout = limits.headersTimeoutMs; server.keepAliveTimeout = limits.keepAliveTimeoutMs;
  server.on("connection", socket => { connections++; sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.on("dropRequest", () => dropped++);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert(address && typeof address !== "string");
  return { port: address.port, counts: () => ({ served, dropped, connections }) };
}

async function pipeline(port: number, total: number) {
  const socket = net.createConnection({ host: "127.0.0.1", port }); socket.setEncoding("utf8");
  let text = "";
  try {
    const responses = new Promise<{ codes: number[]; text: string }>((resolve, reject) => {
      const codes = () => [...text.matchAll(/HTTP\/1\.1 (\d{3})/g)].map(match => Number(match[1]));
      const timer = setTimeout(() => reject(new Error("Synthetic socket response deadline")), 15000);
      socket.on("data", chunk => { text += chunk; if (codes().length >= total) { clearTimeout(timer); resolve({ codes: codes(), text }); } });
      socket.once("end", () => { clearTimeout(timer); resolve({ codes: codes(), text }); });
      socket.once("error", error => { clearTimeout(timer); reject(error); });
    });
    await once(socket, "connect");
    socket.write(Array.from({ length: total }, (_, i) => `GET /synthetic/${i} HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n`).join(""));
    return await responses;
  } finally { socket.destroy(); }
}

test("Manager default preserves a healthy socket beyond 100 requests and retains actual timeout budgets", async t => {
  const limits = actualManagerLimits();
  assert.equal(limits.requestTimeoutMs, 30000); assert.equal(limits.headersTimeoutMs, 10000); assert.equal(limits.keepAliveTimeoutMs, 5000);
  const f = await fixture(t, limits.maxRequestsPerSocket), result = await pipeline(f.port, 130);
  assert.equal(result.codes.length, 130); assert(result.codes.every(code => code === 200));
  assert.deepEqual(f.counts(), { served: 130, dropped: 0, connections: 1 });
  assert.doesNotMatch(result.text, /connection: close/i);
  assert.equal(limits.maxRequestsPerSocket, 0);
});

test("an explicitly positive Node socket limit retains its native close and 503 semantics", async t => {
  const f = await fixture(t, 100), result = await pipeline(f.port, 105);
  assert.deepEqual(f.counts(), { served: 100, dropped: 5, connections: 1 });
  assert.equal(result.codes.filter(code => code === 200).length, 100);
  assert.equal(result.codes.filter(code => code === 503).length, 5);
  assert.match(result.text, /connection: close/i);
});
