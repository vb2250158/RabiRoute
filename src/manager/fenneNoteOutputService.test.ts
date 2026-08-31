import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { FenneNoteOutputService } from "./fenneNoteOutputService.js";

async function listen(service: FenneNoteOutputService): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    if (!service.handle(request, new URL(request.url || "/", "http://localhost"), response)) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: -1 }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  };
}

test("FenneNote service registers only the reply and playback routes", async () => {
  const upstream = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ path: request.url }));
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("missing upstream address");
  const service = new FenneNoteOutputService({
    replyUrl: `http://127.0.0.1:${address.port}/reply`,
    playbackUrl: `http://127.0.0.1:${address.port}/playback`
  });
  const app = await listen(service);
  try {
    for (const [route, path] of [["/api/fennenote/reply", "/reply"], ["/api/fennenote/playback", "/playback"]]) {
      const response = await fetch(app.baseUrl + route, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
      assert.equal(response.status, 202);
      assert.equal((await response.json() as { response: { path: string } }).response.path, path);
    }
  } finally {
    await service.stop();
    await app.close();
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
  }
});

test("FenneNote service returns false for unrelated routes and stops accepting work", async () => {
  const service = new FenneNoteOutputService();
  await service.stop();
  const app = await listen(service);
  try {
    assert.equal((await fetch(app.baseUrl + "/api/unrelated")).status, 404);
    assert.equal((await fetch(app.baseUrl + "/api/playback/request", { method: "POST", body: "{}" })).status, 404);
    const stopped = await fetch(app.baseUrl + "/api/fennenote/reply", { method: "POST", body: "{}" });
    assert.equal(stopped.status, 503);
  } finally {
    await app.close();
  }
});

test("FenneNote service returns a clear 502 when no output endpoint is configured", async () => {
  const previousReply = process.env.FENNOTE_REPLY_URL;
  const previousPlayback = process.env.FENNOTE_PLAYBACK_URL;
  delete process.env.FENNOTE_REPLY_URL;
  delete process.env.FENNOTE_PLAYBACK_URL;
  const service = new FenneNoteOutputService();
  const app = await listen(service);
  try {
    for (const [route, mode, variable] of [
      ["/api/fennenote/reply", "reply", "FENNOTE_REPLY_URL"],
      ["/api/fennenote/playback", "playback", "FENNOTE_PLAYBACK_URL"]
    ]) {
      const result = await fetch(app.baseUrl + route, { method: "POST", body: "{}" });
      assert.equal(result.status, 502);
      const body = await result.json() as { error: string; target?: string };
      assert.match(body.error, new RegExp(`FenneNote ${mode} endpoint is not configured; set ${variable}`));
      assert.equal(body.target, undefined);
    }
  } finally {
    await service.stop();
    await app.close();
    if (previousReply === undefined) delete process.env.FENNOTE_REPLY_URL;
    else process.env.FENNOTE_REPLY_URL = previousReply;
    if (previousPlayback === undefined) delete process.env.FENNOTE_PLAYBACK_URL;
    else process.env.FENNOTE_PLAYBACK_URL = previousPlayback;
  }
});

test("FenneNote service aborts and drains an in-flight request during stop", async () => {
  let upstreamAccepted!: () => void;
  const accepted = new Promise<void>(resolve => { upstreamAccepted = resolve; });
  const upstream = http.createServer((_request, _response) => { upstreamAccepted(); });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("missing upstream address");
  const service = new FenneNoteOutputService({
    replyUrl: `http://127.0.0.1:${address.port}/reply`,
    timeoutMs: 60_000
  });
  const app = await listen(service);
  try {
    const request = fetch(app.baseUrl + "/api/fennenote/reply", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" }
    });
    await accepted;
    await service.stop();
    const response = await request;
    assert.equal(response.status, 502);
    assert.match(JSON.stringify(await response.json()), /FenneNote output plugin stopped/);
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
  }
});
