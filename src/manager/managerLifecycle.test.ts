import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import test from "node:test";
import type { AddressInfo } from "node:net";
import {
  closeManagerEventClients,
  handleManagerEventApi,
  installManagerSignalHandlers,
  listenManagerServer,
  type ManagerSignalTarget
} from "./controlPlaneRoutes.js";

function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

test("Manager listen rejects a conflicting port through its startup promise", async (t) => {
  const owner = http.createServer();
  await listenManagerServer(owner, 0, "127.0.0.1");
  t.after(() => closeServer(owner));
  const address = owner.address() as AddressInfo;

  const duplicate = http.createServer();
  await assert.rejects(
    listenManagerServer(duplicate, address.port, "127.0.0.1"),
    (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE"
  );
  assert.equal(duplicate.listening, false);
});

test("Manager signal handlers can be removed without leaving duplicate shutdown callbacks", () => {
  const target = new EventEmitter();
  const reasons: string[] = [];
  const remove = installManagerSignalHandlers(
    reason => reasons.push(reason),
    target as ManagerSignalTarget
  );

  target.emit("SIGINT");
  target.emit("SIGTERM");
  assert.deepEqual(reasons, ["SIGINT", "SIGTERM"]);

  remove();
  remove();
  target.emit("SIGINT");
  target.emit("SIGTERM");
  assert.deepEqual(reasons, ["SIGINT", "SIGTERM"]);
  assert.equal(target.listenerCount("SIGINT"), 0);
  assert.equal(target.listenerCount("SIGTERM"), 0);
});

test("Manager shutdown closes active event-stream responses", async (t) => {
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    if (handleManagerEventApi(request, requestUrl, response)) return;
    response.writeHead(404).end();
  });
  await listenManagerServer(server, 0, "127.0.0.1");
  t.after(async () => {
    closeManagerEventClients();
    await closeServer(server);
  });
  const address = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${address.port}/api/events`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /^text\/event-stream/);
  assert.ok(response.body);

  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.match(new TextDecoder().decode(first.value), /event: ready/);

  closeManagerEventClients();
  const closed = await Promise.race([
    (async () => {
      while (!(await reader.read()).done) {
        // Drain any already-buffered SSE frame before observing EOF.
      }
      return true;
    })(),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2_000))
  ]);
  assert.equal(closed, true);
});
