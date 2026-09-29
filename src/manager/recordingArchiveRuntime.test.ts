import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { RecordingArchiveRuntime, type RecordingArchiveRuntimeOptions } from "./recordingArchiveRuntime.js";
import { recordingManifestHash } from "./recordingArchiveContract.js";
const namespace = "12345678-1234-4234-8234-123456789abc";
async function fixture(t: import("node:test").TestContext, readProcessing?: RecordingArchiveRuntimeOptions["readProcessing"]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "archive-runtime-"));
  const stateDir = path.join(root, "state"), role = path.join(root, "roles", "role");
  await fs.mkdir(stateDir); await fs.mkdir(path.join(role, "all-day-recording"), { recursive: true });
  let readOnly = false, calls = 0;
  const runtime = new RecordingArchiveRuntime({ stateDir, readProcessing, roleDirectory: () => role, workerId: () => "worker",
    authorizeResources: req => { calls++; return req.headers["authorization"] === "test" ? String(req.headers["x-owner"] ?? "") : null; }, localAdmin: () => true, readOnly: () => readOnly });
  await runtime.bindings.provisionNamespace("role", namespace);
  await runtime.bindings.configure("phone", "role", namespace, 0);
  await runtime.restore();
  const server = http.createServer((req, res) => { void runtime.handle(req, new URL(req.url!, "http://test"), res).then(handled => { if (!handled) { res.writeHead(418); res.end("legacy"); } }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await runtime.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api/resource-cache/data`;
  const request = (url: string, options: RequestInit = {}, owner = "phone") => fetch(base + url, { ...options, headers: { authorization: "test", "x-owner": owner, ...options.headers } });
  const pcm = Buffer.alloc(32000, 1), sha = createHash("sha256").update(pcm).digest("hex");
  const manifest = { schemaVersion: 1, recordId: "record", captureId: "capture", eventId: "event", deviceId: "phone", source: "phone", startedAt: 1000, endedAt: 2000, timeBasis: "received", format: { codec: "pcm_s16le", sampleRate: 16000, channels: 1 }, segments: [{ sequence: 1, bytes: pcm.length, sha256: sha, startedAt: 1000 }], objects: [{ sha256: sha, bytes: pcm.length, offset: 0 }], gaps: [], processingPolicy: "transcribe", totalBytes: pcm.length, sealed: true };
  return { runtime, request, base, pcm, sha, manifest, role, setReadOnly: () => { readOnly = true; }, calls: () => calls };
}
test("synthetic HTTP object/manifest/receipt/catalog share authentication and update projection", async t => {
  const f = await fixture(t), hash = recordingManifestHash(f.manifest);
  const capabilities = await f.request("/archive-capabilities");
  assert.equal(capabilities.status, 200);
  const capability = await capabilities.json();
  assert.equal(capability.bindingRevision, 1); assert.equal(capability.uploadAllowed, true);
  assert.equal("roleId" in capability, false); assert.equal("root" in capability, false);
  assert.equal((await f.request(`/objects/${f.sha}`, { method: "PUT", body: f.pcm })).status, 200);
  const commit = await f.request(`/recordings/record/manifests/${hash}`, { method: "PUT", body: JSON.stringify(f.manifest) });
  assert.equal(commit.status, 200); const receipt = await commit.json(); assert.equal(receipt.durability, "archived");
  assert.deepEqual(await (await f.request(`/recordings/record/receipts/${hash}`)).json(), receipt);
  const page = await (await f.request("/recordings?limit=1")).json(); assert.equal(page.items.length, 1); assert.equal(page.items[0].manifestHash, hash);
  assert.equal((await f.request("/recordings/record/manifest")).status, 200);
  assert.deepEqual(Buffer.from(await (await f.request(`/objects/${f.sha}`)).arrayBuffer()), f.pcm);
  assert.equal(f.calls(), 7);
  await f.runtime.bindings.configure("other", "role", namespace, 0);
  await f.runtime.restoreOwner("other");
  assert.equal((await f.request(`/objects/${f.sha}`, {}, "other")).status, 404);
  assert.equal((await f.request(`/recordings/record/receipts/${hash}`, {}, "other")).status, 404);
  assert.equal((await (await f.request("/recordings", {}, "other")).json()).items.length, 0);
});
test("unknown object owners alone fall through; disabled and unauthorized callers never reach legacy", async t => {
  const f = await fixture(t);
  assert.equal((await f.request(`/objects/${f.sha}`, {}, "unbound")).status, 418);
  assert.equal((await f.request("/archive-capabilities", {}, "unbound")).status, 403);
  assert.equal((await fetch(f.base + `/objects/${f.sha}`)).status, 403);
  await f.runtime.bindings.configure("phone", "role", namespace, 1, false);
  assert.equal((await f.request(`/objects/${f.sha}`, { method: "PUT", body: f.pcm })).status, 403);
  assert.equal((await f.request("/recordings")).status, 403);
});
test("NAS unavailable serves labeled cached history but cannot commit; query and readonly fail closed", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("/recordings?limit=x")).status, 400);
  assert.equal((await f.request("/recordings?limit=1&limit=2")).status, 400);
  f.setReadOnly(); assert.equal((await f.request(`/objects/${f.sha}`, { method: "PUT", body: f.pcm })).status, 403);
  await fs.rename(path.join(f.role, "all-day-recording", "media-archive"), path.join(f.role, "all-day-recording", "offline"));
  const page = await f.request("/recordings"); assert.equal(page.status, 200); assert.equal((await page.json()).offline, true);
  assert.notEqual((await f.request("/archive-capabilities")).status, 200);
  await f.runtime.dispose(); assert.equal((await f.request("/recordings")).status, 503);
});
test("processing overlays only one page with four-read concurrency; empty results and late ASR preserve media cursor", async t => {
  let active = 0, peak = 0, count = 0, complete = false;
  const f = await fixture(t, async (owner, id, hash) => {
    assert.equal(owner, "phone"); assert.match(hash, /^[a-f0-9]{64}$/);
    count++; peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    if (id === "record-0") return { state: "completed", text: "" };
    if (id === "record-1") throw new Error("NAS job read failed");
    return complete ? { state: "completed", text: "recognized" } : { state: "queued" };
  });
  await f.runtime.store.putObject("phone", f.sha, f.pcm);
  for (let i = 0; i < 8; i++) {
    const manifest = { ...f.manifest, recordId: `record-${i}` };
    await f.runtime.store.commitManifest("phone", manifest.recordId, recordingManifestHash(manifest), manifest);
  }
  const first = await (await f.request("/recordings?limit=5")).json();
  assert.equal(count, 5); assert.equal(peak, 4); assert.equal(first.items.length, 5);
  assert.equal(first.items[0].asrState, "completed"); assert.equal(first.items[0].text, "");
  assert.equal(first.items[1].asrState, "unavailable"); assert.equal("text" in first.items[1], false);
  complete = true;
  const late = await (await f.request("/recordings?limit=5")).json();
  assert.equal(late.snapshotRevision, first.snapshotRevision); assert.equal(late.nextCursor, first.nextCursor);
  assert.equal(late.items[2].text, "recognized");
  const single = await (await f.request("/recordings/record-0/processing")).json();
  assert.equal(single.state, "completed"); assert.equal(single.text, "");
  assert.equal((await f.request("/recordings/record-0/processing", {}, "unbound")).status, 403);
  const prior = count;
  await fs.rename(path.join(f.role, "all-day-recording", "media-archive"), path.join(f.role, "all-day-recording", "offline"));
  const offline = await (await f.request("/recordings?limit=5")).json();
  assert.equal(count, prior); assert.equal(offline.offline, true);
  assert.ok(offline.items.every((row: { asrState: string; text?: string }) => row.asrState === "unavailable" && row.text === undefined));
});
test("capabilities reject namespace mismatch and binding revisions changing during read", async t => {
  const f = await fixture(t);
  const original = f.runtime.store.capabilities.bind(f.runtime.store);
  f.runtime.store.capabilities = async owner => ({ ...await original(owner), storageNamespaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  assert.equal((await f.request("/archive-capabilities")).status, 503);
  f.runtime.store.capabilities = async owner => {
    const value = await original(owner);
    await f.runtime.bindings.configure("phone", "role", namespace, 1, false);
    await f.runtime.bindings.configure("phone", "role", namespace, 2, true);
    return value;
  };
  assert.equal((await f.request("/archive-capabilities")).status, 503);
  await f.runtime.bindings.configure("phone", "role", namespace, 3, false);
  assert.equal((await f.request("/archive-capabilities")).status, 403);
});
test("missing processing callback does not invent a queued job", async t => {
  const f = await fixture(t), hash = recordingManifestHash(f.manifest);
  await f.runtime.store.putObject("phone", f.sha, f.pcm);
  await f.runtime.store.commitManifest("phone", "record", hash, f.manifest);
  assert.equal((await (await f.request("/recordings")).json()).items[0].asrState, "unavailable");
  assert.equal((await (await f.request("/recordings/record/processing")).json()).state, "unavailable");
});
