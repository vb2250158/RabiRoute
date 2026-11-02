import assert from "node:assert/strict";
import net, { type Socket } from "node:net";
import { once } from "node:events";
import test from "node:test";
import { fetchPortBlocked, ManagedHaLoopbackProxy, type ManagedHaTarget } from "./managedHaLoopbackProxy.js";

async function listener(handler: (socket: Socket) => void): Promise<net.Server> {
  const server = net.createServer({ allowHalfOpen: true }, handler);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return server;
}
function portOf(server: net.Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Not listening.");
  return address.port;
}
function dial(baseUrl: string): Socket {
  const url = new URL(baseUrl);
  return net.createConnection({ host: url.hostname, port: Number(url.port) });
}
async function readBytes(socket: Socket, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    const cleanup = () => { socket.off("data", onData); socket.off("close", onClose); socket.off("error", onError); };
    const onData = (chunk: Buffer) => { chunks.push(chunk); size += chunk.length; if (size >= length) { cleanup(); resolve(Buffer.concat(chunks)); } };
    const onClose = () => { cleanup(); reject(new Error("Connection closed before the response arrived.")); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    socket.on("data", onData); socket.once("close", onClose); socket.once("error", onError);
  });
}

test("OS-assigned loopback endpoints coexist with an occupied local port", async t => {
  const occupied = await listener(socket => socket.destroy());
  const a = await ManagedHaLoopbackProxy.listen();
  const b = await ManagedHaLoopbackProxy.listen();
  t.after(async () => { await a.close(); await b.close(); await new Promise<void>(resolve => occupied.close(() => resolve())); });
  const aUrl = new URL(a.baseUrl), bUrl = new URL(b.baseUrl);
  assert.equal(aUrl.hostname, "127.0.0.1");
  assert.notEqual(aUrl.port, bUrl.port);
  assert.notEqual(Number(aUrl.port), portOf(occupied));
  assert.notEqual(Number(bUrl.port), portOf(occupied));
  assert.throws(() => a.setTarget({ address: "localhost", port: 80 }), /Invalid managed HA target/);
  assert.throws(() => a.setTarget({ address: "127.0.0.1", port: 80 }), /Invalid managed HA target/);
  assert.throws(() => a.setTarget({ address: "10.0.0.1", port: 443 as 80 }), /Invalid managed HA target/);
  const denied = dial(a.baseUrl);
  denied.on("error", () => {});
  await once(denied, "close");
});

test("fetch-blocked OS allocations are released and retried with a finite budget", async t => {
  assert.equal(await fetchPortBlocked(6000), true);
  const server = await listener(socket => socket.destroy());
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  assert.equal(await fetchPortBlocked(portOf(server)), false);
  const blocked: number[] = [];
  const proxy = await ManagedHaLoopbackProxy.listen({ fetchPortBlocked: async port => { blocked.push(port); return blocked.length === 1; } });
  t.after(() => proxy.close());
  assert.equal(blocked.length, 2);
  let attempts = 0;
  await assert.rejects(ManagedHaLoopbackProxy.listen({ fetchPortBlocked: async () => { attempts++; return true; } }), /accepted by Fetch/);
  assert.equal(attempts, 16);
});

test("byte stream is bidirectional and target changes fence old connections", async t => {
  const first = await listener(socket => { socket.write("A"); socket.pipe(socket); });
  const second = await listener(socket => { socket.write("B"); socket.pipe(socket); });
  const destinations = new Map([["10.0.0.1", portOf(first)], ["10.0.0.2", portOf(second)]]);
  const proxy = await ManagedHaLoopbackProxy.listen({ connect: (target: ManagedHaTarget) => {
    const port = destinations.get(target.address);
    if (!port) throw new Error("Unknown fixture target.");
    return net.createConnection({ host: "127.0.0.1", port, allowHalfOpen: true });
  } });
  t.after(async () => { await proxy.close(); await Promise.all([first, second].map(server => new Promise<void>(resolve => server.close(() => resolve())))); });
  proxy.setTarget({ address: "10.0.0.1", port: 80 });
  const old = dial(proxy.baseUrl);
  old.on("error", () => {});
  assert.equal((await readBytes(old, 1)).toString(), "A");
  const payload = Buffer.alloc(1024 * 1024, 0x5a);
  const response = readBytes(old, payload.length);
  old.write(payload);
  assert.deepEqual(await response, payload);
  const closed = once(old, "close");
  proxy.setTarget({ address: "10.0.0.2", port: 8123 });
  await closed;
  const current = dial(proxy.baseUrl);
  current.on("error", () => {});
  assert.equal((await readBytes(current, 1)).toString(), "B");
  current.destroy();
});

test("connection limit, idle timeout, and close release the listening port", async t => {
  const backend = await listener(socket => { socket.on("end", () => socket.end()); });
  const proxy = await ManagedHaLoopbackProxy.listen({ maxConnections: 1, idleTimeoutMs: 1000,
    connect: () => net.createConnection({ host: "127.0.0.1", port: portOf(backend), allowHalfOpen: true }) });
  t.after(async () => { await proxy.close(); await new Promise<void>(resolve => backend.close(() => resolve())); });
  proxy.setTarget({ address: "10.0.0.1", port: 80 });
  const url = proxy.baseUrl;
  const first = dial(url);
  first.on("error", () => {});
  await once(first, "connect");
  const rejected = dial(url);
  rejected.on("error", () => {});
  await once(rejected, "close");
  await once(first, "close");
  await proxy.close();
  assert.throws(() => proxy.baseUrl, /not available/);
  const rebound = net.createServer();
  await new Promise<void>((resolve, reject) => { rebound.once("error", reject); rebound.listen(Number(new URL(url).port), "127.0.0.1", resolve); });
  await new Promise<void>(resolve => rebound.close(() => resolve()));
});

test("a client half-close still receives the upstream response", async t => {
  const backend = await listener(socket => {
    const chunks: Buffer[] = [];
    socket.on("data", chunk => chunks.push(chunk));
    socket.on("end", () => socket.end(Buffer.concat(chunks)));
  });
  const proxy = await ManagedHaLoopbackProxy.listen({ connect: () => net.createConnection({ host: "127.0.0.1", port: portOf(backend), allowHalfOpen: true }) });
  t.after(async () => { await proxy.close(); await new Promise<void>(resolve => backend.close(() => resolve())); });
  proxy.setTarget({ address: "10.0.0.1", port: 80 });
  const url = new URL(proxy.baseUrl);
  const client = net.createConnection({ host: url.hostname, port: Number(url.port), allowHalfOpen: true });
  client.on("error", () => {});
  const reply = readBytes(client, 4);
  client.end("ping");
  assert.equal((await reply).toString(), "ping");
  client.destroy();
});
