import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { AgentUploadStore, AgentUploadStoreError, type AgentUploadStoreOptions } from "./agentUploadStore.js";
import { installDataMutationAuditSink } from "../observability/dataMutationAudit.js";

const owner = { nodeId: "test-node", agentId: "test-agent" };
function input(text = "test content", uploadId: string = randomUUID(), fileName = "report.txt") {
  const content = Buffer.from(text);
  return { owner, uploadId, fileName, content, sha256: createHash("sha256").update(content).digest("hex") };
}
function fixture(options: Partial<AgentUploadStoreOptions> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-upload-test-"));
  const rootDir = path.join(home, "uploads");
  return { home, rootDir, store: new AgentUploadStore({ rootDir, ...options }), close: () => fs.rmSync(home, { recursive: true, force: true }) };
}
test("generated 32 MiB stream uploads and leases without whole-file buffers", async () => {
  const f = fixture();
  try {
    const chunk = Buffer.alloc(256 * 1024, 0x6b); const chunks = 128;
    const digest = createHash("sha256"); for (let index = 0; index < chunks; index++) digest.update(chunk);
    const sha256 = digest.digest("hex"); const uploadId = randomUUID();
    const receipt = await f.store.uploadStream({ owner, uploadId, fileName: "large.apk", size: chunk.length * chunks, sha256,
      content: (async function* () { for (let index = 0; index < chunks; index++) yield chunk; })() });
    assert.equal(receipt.size, 32 * 1024 * 1024);
    await f.store.withFile(owner, uploadId, file => {
      assert.equal(file.sha256, sha256); assert.equal(fs.statSync(file.path).size, receipt.size);
    });
  } finally { f.close(); }
});

test("streaming reserves cross-instance capacity, bounds bytes, reauthorizes and cleans failures", async () => {
  const f = fixture({ maxFileBytes: 8, maxTotalBytes: 8 });
  try {
    let resume!: () => void; let started!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const ready = new Promise<void>(resolve => { started = resolve; });
    const request = input("12345678");
    const active = f.store.uploadStream({ ...request, size: 8, content: (async function* () { started(); yield Buffer.from("1234"); await gate; yield Buffer.from("5678"); })() });
    await ready;
    const other = new AgentUploadStore({ rootDir: f.rootDir, maxFileBytes: 8, maxTotalBytes: 8 });
    await assert.rejects(other.uploadStream({ ...input("a"), size: 1, content: (async function* () { yield Buffer.from("a"); })() }), errorCode("capacity"));
    await assert.rejects(other.uploadStream({ ...request, size: 8, content: (async function* () { yield request.content; })() }), errorCode("conflict"));
    resume(); const receipt = await active; assert.equal(receipt.size, 8);
    assert.equal(other.resolve(owner, receipt.id).sha256, request.sha256);
    assert.deepEqual(await other.uploadStream({ ...request, size: 8, content: (async function* () { yield request.content; })() }), receipt);
    assert.equal(fs.readdirSync(f.rootDir).some(name => name.startsWith(".stream-")), false);
  } finally { f.close(); }
  const g = fixture({ maxFileBytes: 8 });
  try {
    const request = input("abcd");
    await assert.rejects(g.store.uploadStream({ ...request, size: 3, content: (async function* () { yield request.content; })() }), errorCode("capacity"));
    await assert.rejects(g.store.uploadStream({ ...request, size: 4, beforeCommit() { throw new Error("revoked"); }, content: (async function* () { yield request.content; })() }), /revoked/);
    assert.equal(fs.readdirSync(g.rootDir).some(name => name.startsWith(".stream-")), false);
    assert.throws(() => g.store.get(owner, request.uploadId), errorCode("not_found"));
    assert.throws(() => new AgentUploadStore({ rootDir: g.rootDir, maxFileBytes: 2 * 1024 ** 3 + 1 }), errorCode("invalid_input"));
  } finally { g.close(); }
});

const errorCode = (code: string) => (error: unknown) => error instanceof AgentUploadStoreError && error.code === code;

test("interrupted stream reservation transitions recover under the next writer", async () => {
  const f = fixture(); const rename = fs.renameSync;
  try {
    const request = input("abc"); let injected = false;
    fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
      if (!injected && String(source).includes(".tmp-") && String(destination).includes(".stream-")) { injected = true; throw new Error("fixture prepare interruption"); }
      return rename(source, destination);
    }) as typeof fs.renameSync;
    await assert.rejects(f.store.uploadStream({ ...request, size: 3, content: (async function* () { yield request.content; })() }));
    fs.renameSync = rename;
    const recovered = await f.store.uploadStream({ ...request, size: 3, content: (async function* () { yield request.content; })() });
    assert.equal(recovered.size, 3);
    assert.equal(fs.readdirSync(f.rootDir).some(name => name.startsWith(".tmp-") || name.startsWith(".stream-")), false);
  } finally { fs.renameSync = rename; f.close(); }
});

test("lowered upload limits retain old receipts and can expire larger files", async () => {
  let now = 1000; const f = fixture({ maxFileBytes: 16, ttlMs: 10, now: () => now });
  try {
    const old = f.store.upload(input("12345678"));
    const lower = new AgentUploadStore({ rootDir: f.rootDir, maxFileBytes: 4, ttlMs: 10, now: () => now });
    assert.equal(lower.get(owner, old.id).size, 8);
    now = 1011;
    const next = input("abc");
    await lower.uploadStream({ ...next, size: 3, content: (async function* () { yield next.content; })() });
    assert.throws(() => lower.get(owner, old.id), errorCode("not_found"));
  } finally { f.close(); }
});

test("upload commits receipt and bytes, restart reads, replay keeps original expiry", () => {
  const f = fixture();
  try {
    const request = input();
    const result = f.store.upload(request);
    assert.equal(result.id, request.uploadId);
    assert.deepEqual(Object.keys(result).sort(), ["expiresAt", "fileName", "id", "sha256", "size"]);
    const restarted = new AgentUploadStore({ rootDir: f.rootDir });
    assert.deepEqual(restarted.get(owner, result.id), result);
    assert.deepEqual(restarted.upload(request), result);
    const resolved = restarted.resolve(owner, result.id);
    assert.equal(path.basename(resolved.path), "data.bin");
    assert.deepEqual(fs.readFileSync(resolved.path), request.content);
    assert.equal(restarted.maxFileBytes, 2 * 1024 ** 3);
    assert.ok(Object.isFrozen(restarted.limits));
  } finally { f.close(); }
});

test("same id conflicts on filename or digest; exact node and agent ownership", () => {
  const f = fixture();
  try {
    const request = input(); f.store.upload(request);
    assert.throws(() => f.store.upload(input("changed", request.uploadId)), errorCode("conflict"));
    assert.throws(() => f.store.upload({ ...request, fileName: "other.txt" }), errorCode("conflict"));
    for (const other of [{ ...owner, agentId: "other" }, { ...owner, nodeId: "other" }]) {
      assert.throws(() => f.store.get(other, request.uploadId), errorCode("not_found"));
      assert.throws(() => f.store.resolve(other, request.uploadId), errorCode("not_found"));
      assert.throws(() => f.store.upload({ ...request, owner: other }), errorCode("not_found"));
    }
  } finally { f.close(); }
});

test("TTL cleanup and abandoned staging recovery occur on writes only", () => {
  let now = 1000;
  const f = fixture({ now: () => now, ttlMs: 100 });
  try {
    const first = f.store.upload(input());
    const staging = path.join(f.rootDir, `.tmp-${randomUUID()}`);
    fs.mkdirSync(staging); fs.writeFileSync(path.join(staging, "data.bin"), "partial");
    now = 1100;
    assert.throws(() => f.store.get(owner, first.id), errorCode("not_found"));
    assert.ok(fs.existsSync(path.join(f.rootDir, first.id)));
    f.store.upload(input());
    assert.equal(fs.existsSync(path.join(f.rootDir, first.id)), false);
    assert.equal(fs.existsSync(staging), false);
  } finally { f.close(); }
});

test("capacity boundaries reject before payload write and allow exact limits", () => {
  const f = fixture({ maxFileBytes: 3, maxTotalBytes: 5, maxFiles: 2 });
  try {
    assert.throws(() => f.store.upload(input("1234")), errorCode("capacity"));
    assert.deepEqual(fs.readdirSync(f.rootDir), []);
    f.store.upload(input("123"));
    assert.throws(() => f.store.upload(input("123")), errorCode("capacity"));
    f.store.upload(input("12"));
    assert.throws(() => f.store.upload(input("")), errorCode("capacity"));
    assert.equal(fs.readdirSync(f.rootDir).length, 2);
  } finally { f.close(); }
});

test("reject traversal, alternate streams, reserved names, controls and invalid ids", () => {
  const f = fixture();
  try {
    for (const name of ["../x", "..\\x", "C:\\x", "x/y", "x:y", "CON", "NUL.txt", "LPT1.pdf", "COM¹", "CON .txt", "a\0b", "a\nb", "name.", "name ", ".", "..", ""]) {
      assert.throws(() => f.store.upload(input("a", randomUUID(), name)), errorCode("invalid_input"), name);
    }
    for (const id of ["../x", "C:\\x", "bad", "00000000-0000-0000-0000-000000000000"]) {
      assert.throws(() => f.store.get(owner, id), errorCode("invalid_input"));
    }
    assert.throws(() => f.store.upload({ ...input(), sha256: "0".repeat(64) }), errorCode("integrity"));
    assert.deepEqual(fs.readdirSync(f.rootDir), []);
  } finally { f.close(); }
});

test("unknown schema, missing bytes, unexpected managed entry and hash tampering fail closed", () => {
  for (const mutation of ["schema", "missing", "hash", "extra"]) {
    const f = fixture();
    try {
      const record = f.store.upload(input("original"));
      const dir = path.join(f.rootDir, record.id);
      if (mutation === "schema") {
        const metadata = JSON.parse(fs.readFileSync(path.join(dir, "record.json"), "utf8"));
        metadata.schemaVersion = 2;
        fs.writeFileSync(path.join(dir, "record.json"), JSON.stringify(metadata));
      }
      if (mutation === "missing") fs.unlinkSync(path.join(dir, "data.bin"));
      if (mutation === "hash") fs.writeFileSync(path.join(dir, "data.bin"), "modified");
      if (mutation === "extra") fs.writeFileSync(path.join(dir, "foreign"), "untouched");
      assert.throws(() => f.store.resolve(owner, record.id), error => error instanceof AgentUploadStoreError);
      if (mutation !== "hash") assert.throws(() => f.store.upload(input()), error => error instanceof AgentUploadStoreError);
      if (mutation === "extra") assert.equal(fs.readFileSync(path.join(dir, "foreign"), "utf8"), "untouched");
    } finally { f.close(); }
  }
});

test("reject directory junctions at root, ancestor, record and staging without touching targets", () => {
  const f = fixture();
  try {
    const outside = path.join(f.home, "outside"); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "sentinel"), "keep");
    const alias = path.join(f.home, "alias"); fs.symlinkSync(outside, alias, "junction");
    assert.throws(() => new AgentUploadStore({ rootDir: alias }), errorCode("unsafe_storage"));
    assert.throws(() => new AgentUploadStore({ rootDir: path.join(alias, "nested") }), errorCode("unsafe_storage"));
    assert.equal(fs.existsSync(path.join(outside, "nested")), false);
    const id = randomUUID(); fs.symlinkSync(outside, path.join(f.rootDir, id), "junction");
    assert.throws(() => f.store.get(owner, id), errorCode("unsafe_storage"));
    fs.unlinkSync(path.join(f.rootDir, id));
    fs.symlinkSync(outside, path.join(f.rootDir, `.tmp-${randomUUID()}`), "junction");
    assert.throws(() => f.store.upload(input()), errorCode("unsafe_storage"));
    assert.equal(fs.readFileSync(path.join(outside, "sentinel"), "utf8"), "keep");
  } finally { f.close(); }
});

test("reject hardlinks for data, receipt and lock without changing external file", () => {
  for (const name of ["data.bin", "record.json", ".store.lock"]) {
    const f = fixture();
    try {
      const record = f.store.upload(input());
      const target = name === ".store.lock" ? path.join(f.rootDir, name) : path.join(f.rootDir, record.id, name);
      const outside = path.join(f.home, "external");
      fs.writeFileSync(outside, "external sentinel");
      if (fs.existsSync(target)) fs.unlinkSync(target);
      fs.linkSync(outside, target);
      assert.throws(() => f.store.resolve(owner, record.id), errorCode("unsafe_storage"));
      assert.equal(fs.readFileSync(outside, "utf8"), "external sentinel");
    } finally { f.close(); }
  }
});

test("withFile leases survive expiry and other store cleanup; callback failure releases", async () => {
  let now = 1000;
  const f = fixture({ ttlMs: 10, now: () => now, maxFiles: 2 });
  try {
    const item = f.store.upload(input());
    const second = new AgentUploadStore({ rootDir: f.rootDir, ttlMs: 10, now: () => now, maxFiles: 2 });
    await assert.rejects(f.store.withFile(owner, item.id, async file => {
      now = 1010;
      second.upload(input());
      assert.equal(fs.readFileSync(file.path, "utf8"), "test content");
      assert.throws(() => second.upload(input()), errorCode("capacity"));
      await Promise.resolve();
      throw new Error("callback failure");
    }), /callback failure/);
    second.upload(input());
    assert.equal(fs.existsSync(path.join(f.rootDir, item.id)), false);
  } finally { f.close(); }
});

test("nested leases release independently and active lease blocks expiry deletion", async () => {
  let now = 100;
  const f = fixture({ ttlMs: 10, now: () => now });
  try {
    const item = f.store.upload(input());
    await f.store.withFile(owner, item.id, async outer => {
      await f.store.withFile(owner, item.id, async () => {});
      now = 110;
      f.store.upload(input());
      assert.ok(fs.existsSync(outer.path));
    });
    f.store.upload(input());
    assert.equal(fs.existsSync(path.join(f.rootDir, item.id)), false);
  } finally { f.close(); }
});

test("lease release failure cannot override a successful send or callback error", async (t) => {
  const f = fixture(); const records: unknown[] = [];
  const release = installDataMutationAuditSink(record => records.push(record));
  try {
    const item = f.store.upload(input());
    const unlink = fs.unlinkSync;
    const mock = t.mock.method(fs, "unlinkSync", (file: fs.PathLike) => {
      if (path.basename(String(file)).startsWith(".lease-")) throw new Error("release failure");
      return unlink(file);
    });
    assert.equal(await f.store.withFile(owner, item.id, async () => "sent"), "sent");
    const callbackError = new Error("send failed");
    await assert.rejects(f.store.withFile(owner, item.id, async () => { throw callbackError; }), error => error === callbackError);
    assert.equal(fs.readdirSync(path.join(f.rootDir, item.id)).filter(name => name.startsWith(".lease-")).length, 2);
    assert.ok(JSON.stringify(records).includes("storage_failure"));
    mock.mock.restore();
  } finally { release(); f.close(); }
});

test("interrupted commit returns no receipt and next writer recovers partial staging", (t) => {
  const f = fixture();
  try {
    const request = input();
    const rename = fs.renameSync;
    const mocked = t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === path.join(f.rootDir, request.uploadId)) throw new Error("simulated commit interruption");
      return rename(from, to);
    });
    assert.throws(() => f.store.upload(request), errorCode("storage_failure"));
    assert.throws(() => f.store.get(owner, request.uploadId), errorCode("not_found"));
    assert.equal(fs.readdirSync(f.rootDir).filter(name => name.startsWith(".tmp-")).length, 1);
    mocked.mock.restore();
    const restarted = new AgentUploadStore({ rootDir: f.rootDir });
    const receipt = restarted.upload(request);
    assert.equal(receipt.id, request.uploadId);
    assert.equal(fs.readdirSync(f.rootDir).filter(name => name.startsWith(".tmp-")).length, 0);
  } finally { f.close(); }
});

test("audit contains operation results but no body, private path or original filename", () => {
  const f = fixture(); const records: unknown[] = [];
  const release = installDataMutationAuditSink(record => records.push(record));
  try {
    const item = f.store.upload(input("private payload marker", randomUUID(), "private-original-name.txt"));
    f.store.resolve(owner, item.id);
    assert.throws(() => f.store.upload(input("other", item.id)), errorCode("conflict"));
    const serialized = JSON.stringify(records);
    for (const secret of [f.home, "private payload marker", "private-original-name.txt"]) assert.equal(serialized.includes(secret), false);
    assert.ok(serialized.includes("committed")); assert.ok(serialized.includes("rejected"));
  } finally { release(); f.close(); }
});
