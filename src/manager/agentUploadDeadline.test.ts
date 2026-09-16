import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { guardRequestBodyDeadline } from "./agentUploadDeadline.js";

async function fixture(t: test.TestContext, handler: http.RequestListener) {
  const server = http.createServer(handler);
  server.requestTimeout = 1_800_000;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

function startBody(t: test.TestContext, url: string, agent: http.Agent | false = false) {
  const request = http.request(url, { method: "PUT", headers: { "Content-Length": "2" }, agent });
  t.after(() => request.destroy());
  const result = new Promise<{ status: number | undefined; connection: string | undefined; body: string }>((resolve, reject) => {
    request.on("error", reject);
    request.on("response", response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode, connection: response.headers.connection, body }));
    });
  });
  request.write("a");
  return { request, result };
}

for (const caption of ["ordinary", "unauthorized upload"]) {
  test(`${caption} slow body receives 408 and closes the connection`, { timeout: 5_000 }, async t => {
    const url = await fixture(t, (req, res) => {
      const before = req.listenerCount("data");
      guardRequestBodyDeadline(req, res, { normalMs: 100, uploadMs: 1_000, isAuthorizedUpload: false });
      assert.equal(req.listenerCount("data"), before, "guard must not compete with the body consumer");
      assert.equal(req.readableFlowing, null);
    });
    const { request, result } = startBody(t, `${url}/${caption === "ordinary" ? "api/normal" : "api/agent/uploads/00000000-0000-4000-8000-000000000001"}`);
    const closed = once(request, "close");
    const response = await result;
    assert.equal(response.status, 408);
    assert.equal(response.connection, "close");
    assert.match(response.body, /deadline exceeded/);
    await closed;
  });
}

test("authorized upload keeps its longer window and the consumer receives every byte", { timeout: 5_000 }, async t => {
  const url = await fixture(t, (req, res) => {
    guardRequestBodyDeadline(req, res, { normalMs: 100, uploadMs: 1_000, isAuthorizedUpload: true });
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => res.end(body));
  });
  const { request, result } = startBody(t, url);
  await delay(250);
  request.end("b");
  assert.deepEqual(await result, { status: 200, connection: "close", body: "ab" });
});

test("body end clears the deadline without limiting a slow response", { timeout: 5_000 }, async t => {
  const url = await fixture(t, (req, res) => {
    guardRequestBodyDeadline(req, res, { normalMs: 100, isAuthorizedUpload: false });
    req.resume();
    req.on("end", () => { setTimeout(() => res.end("late response"), 250); });
  });
  const { request, result } = startBody(t, url);
  request.end("b");
  assert.equal((await result).body, "late response");
});

test("disconnect removes deadline listeners and cannot write a late 408", { timeout: 5_000 }, async t => {
  let accept!: (value: { req: http.IncomingMessage; res: http.ServerResponse; dispose: () => void; baseline: number[] }) => void;
  const accepted = new Promise<Parameters<typeof accept>[0]>(resolve => { accept = resolve; });
  const url = await fixture(t, (req, res) => {
    const baseline = [req.listenerCount("end"), req.listenerCount("aborted"), res.listenerCount("finish")];
    const dispose = guardRequestBodyDeadline(req, res, { normalMs: 100, isAuthorizedUpload: false });
    accept({ req, res, dispose, baseline });
  });
  const { request, result } = startBody(t, url);
  // The intentionally disconnected client rejects rather than receiving a response.
  const failed = result.catch(error => error);
  const { req, res, dispose, baseline } = await accepted;
  const closed = new Promise<void>(resolve => req.once("close", resolve));
  request.destroy();
  await closed;
  await failed;
  assert.deepEqual([req.listenerCount("end"), req.listenerCount("aborted"), res.listenerCount("finish")], baseline);
  dispose();
  dispose();
  await delay(200);
  assert.equal(res.headersSent, false);
});

test("completed requests never arm a deadline, even before readable end", { timeout: 5_000 }, async t => {
  const url = await fixture(t, (req, res) => {
    // Leave the body paused; HTTP parsing can complete without consumer end.
    setTimeout(() => {
      assert.equal(req.complete, true);
      assert.equal(req.readableEnded, false);
      const before = req.listenerCount("end");
      const dispose = guardRequestBodyDeadline(req, res, { normalMs: 20, isAuthorizedUpload: false });
      assert.equal(req.listenerCount("end"), before);
      dispose();
      setTimeout(() => res.end("already complete"), 80);
    }, 80);
  });
  const { request, result } = startBody(t, url);
  request.end("b");
  assert.equal((await result).body, "already complete");
});

test("authorized uploads still expire at their body deadline", { timeout: 5_000 }, async t => {
  const url = await fixture(t, (req, res) => {
    guardRequestBodyDeadline(req, res, { normalMs: 20, uploadMs: 150, isAuthorizedUpload: true });
  });
  const { result } = startBody(t, url);
  assert.equal((await result).status, 408);
});

test("early response finish removes deadline listeners while the body is incomplete", { timeout: 5_000 }, async t => {
  let finished!: () => void;
  const checked = new Promise<void>(resolve => { finished = resolve; });
  const url = await fixture(t, (req, res) => {
    const events = ["end", "aborted", "close"] as const;
    const before = events.map(event => req.listeners(event));
    guardRequestBodyDeadline(req, res, { normalMs: 50, isAuthorizedUpload: false });
    const added = events.map((event, index) => req.listeners(event).filter(listener => !before[index].includes(listener)));
    res.once("finish", () => {
      assert.equal(req.complete, false);
      // Node itself may add an end listener when finishing an early response.
      events.forEach((event, index) => {
        for (const listener of added[index]) assert.equal(req.listeners(event).includes(listener), false);
      });
      finished();
    });
    res.end("early response");
  });
  const agent = new http.Agent({ keepAlive: true });
  t.after(() => agent.destroy());
  const { request, result } = startBody(t, url, agent);
  const [socket] = await once(request, "socket");
  const closed = once(socket, "close");
  assert.equal((await result).body, "early response");
  await checked;
  await closed;
  assert.equal(socket.destroyed, true);
});

test("explicit dispose cancels an unfinished body's deadline", { timeout: 5_000 }, async t => {
  const url = await fixture(t, (req, res) => {
    const dispose = guardRequestBodyDeadline(req, res, { normalMs: 50, isAuthorizedUpload: false });
    dispose();
    dispose();
    req.resume();
    req.on("end", () => res.end("disposed"));
  });
  const { request, result } = startBody(t, url);
  await delay(150);
  request.end("b");
  assert.equal((await result).body, "disposed");
});
