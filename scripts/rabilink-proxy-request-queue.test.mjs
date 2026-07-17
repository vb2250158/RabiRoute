import assert from "node:assert/strict";
import test from "node:test";
import { RelayProxyRequestQueue } from "./rabilink-proxy-request-queue.mjs";

test("proxy queue leases, completes and releases request bodies", async () => {
  const queue = new RelayProxyRequestQueue({
    name: "Speech",
    idPrefix: "speech",
    requestWaitMs: 1000,
    leaseMs: 100,
    retentionMs: 1000
  });
  const request = queue.create({
    appId: "app-a",
    targetDeviceId: "pc-a",
    method: "POST",
    path: "/v1/audio/speech",
    bodyBase64: Buffer.from("request").toString("base64")
  });
  const claimed = queue.claim(1, (item) => item.appId === "app-a" && item.targetDeviceId === "pc-a");
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].status, "leased");
  const waiting = queue.waitForCompletion(request, 500);
  const completed = queue.complete(request.id, {
    ok: true,
    statusCode: 200,
    headers: { "content-type": "audio/wav" },
    bodyBase64: Buffer.from("response").toString("base64")
  });
  assert.equal(completed.deduplicated, false);
  assert.equal((await waiting).status, "done");
  assert.equal(completed.request.bodyBase64, "");
  assert.equal(Buffer.from(completed.request.response.bodyBase64, "base64").toString(), "response");
});

test("proxy queue wakes a matching long poll without waking unrelated claims", async () => {
  const queue = new RelayProxyRequestQueue({
    name: "Speech",
    idPrefix: "speech",
    requestWaitMs: 1000,
    leaseMs: 100,
    retentionMs: 1000
  });
  let matched = false;
  const waiting = queue.waitForClaimable(500, (item) => item.appId === "app-b").then(() => { matched = true; });
  queue.create({ appId: "app-a", targetDeviceId: "pc-a" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(matched, false);
  queue.create({ appId: "app-b", targetDeviceId: "pc-b" });
  await waiting;
  assert.equal(matched, true);
});

test("proxy queue turns a caller timeout into a failed request and releases private input", async () => {
  const queue = new RelayProxyRequestQueue({
    name: "Speech",
    idPrefix: "speech",
    requestWaitMs: 20,
    leaseMs: 100,
    retentionMs: 1000
  });
  const request = queue.create({
    appId: "app-a",
    targetDeviceId: "pc-a",
    bodyBase64: Buffer.from("private audio").toString("base64")
  });
  const completed = await queue.waitForCompletion(request, 20);
  assert.equal(completed.status, "failed");
  assert.match(completed.error, /timed out/i);
  assert.equal(completed.bodyBase64, "");
});
