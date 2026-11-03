import assert from "node:assert/strict";
import http from "node:http";
import { getEventListeners } from "node:events";
import test from "node:test";
import { nativeHttpTestFetch, nativeHttpTestStreamFetch } from "./nativeHttpTestClient.js";

test("native fixture HTTP preserves a UTF-8 DELETE body with real HTTP message framing", async t => {
  const body = JSON.stringify({ message: "消息 😀", replacement: "active" });
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      method: request.method, length: request.headers["content-length"], body: Buffer.concat(chunks).toString("utf8")
    }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const response = await nativeHttpTestFetch(`http://127.0.0.1:${port}/statuses/old`, {
    method: "DELETE", headers: { "content-type": "application/json" }, body
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { method: "DELETE", length: String(Buffer.byteLength(body)), body });
});

test("native fixture stream yields before end and cancellation or abort closes its original response", { timeout: 5000 }, async t => {
  const responses: http.ServerResponse[] = [];
  const closes = Array.from({ length: 2 }, () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  });
  const server = http.createServer((_request, response) => {
    const index = responses.push(response) - 1;
    response.once("close", () => closes[index].resolve());
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: first\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/events`;
  for (const [index, mode] of ["cancel", "abort"].entries()) {
    const controller = new AbortController();
    const response = await nativeHttpTestStreamFetch(url, { signal: controller.signal });
    const reader = response.body!.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), "data: first\n\n");
    assert.equal(responses[index].writableEnded, false, "First chunk must arrive while the SSE response remains open.");
    if (mode === "cancel") await reader.cancel();
    else { const pending = reader.read(); controller.abort(); await assert.rejects(pending); }
    await closes[index].promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(getEventListeners(controller.signal, "abort").length, 0, "Closed HTTP resources must release their abort listener.");
  }
});
