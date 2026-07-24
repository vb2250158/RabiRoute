import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { proxySpeechEventStream } from "./speechEventProxy.js";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("Unable to reserve test port."));
      else resolve(address.port);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test("speech SSE proxy treats client disconnect abort as a normal terminal event", async () => {
  let upstreamAborted = false;
  const server = http.createServer((request, response) => {
    if (request.url === "/events") {
      proxySpeechEventStream(response, {
        openUpstream: async signal => new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("event: ready\ndata: {}\n\n"));
            signal.addEventListener("abort", () => {
              upstreamAborted = true;
              controller.error(new DOMException("This operation was aborted", "AbortError"));
            }, { once: true });
          }
        }), { status: 200, headers: { "content-type": "text/event-stream" } })
      });
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  const port = await listen(server);
  try {
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body?.getReader();
    assert.ok(reader);
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /event: ready/);
    controller.abort();
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    assert.equal(upstreamAborted, true);

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
  } finally {
    await close(server);
  }
});
test("speech SSE proxy rejects a non-event upstream before streaming", async () => {
  const server = http.createServer((_request, response) => {
    proxySpeechEventStream(response, {
      openUpstream: async () => new Response("<html>stale</html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" }
      })
    });
  });
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/events`);
    assert.equal(response.status, 502);
    assert.match(String((await response.json()).message), /did not return an SSE stream/);
  } finally {
    await close(server);
  }
});
