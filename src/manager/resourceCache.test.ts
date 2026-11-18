import { randomBytes as replacementCredentialBytes } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import http from "node:http";
import { ResourceCache } from "./resourceCache.js";
import { resourceCacheFixtureHandler as resourceCacheHandler } from "./resourceApiTestSupport.js";
import { Readable } from "node:stream";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest } from "./lanAgentRequestAccess.js";
import { RabiGlobalConfigStore } from "./globalConfig.js";
import ts from "typescript";
import { RESOURCE_OBJECT_MAX_BYTES } from "./resourceCacheProtocol.js";

async function resourceFixtureSnapshot(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name), relative = path.relative(root, file);
      if (entry.isDirectory()) { result.push(`dir:${relative}`); await visit(file); }
      else if (entry.isFile()) result.push(`file:${relative}:${createHash("sha256").update(await fs.readFile(file)).digest("hex")}`);
      else result.push(`other:${relative}`);
    }
  }
  await visit(root);
  return result.sort();
}

test("resource owner enumeration is isolated, durable, read-only and rejects corruption", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "resource-owner-list-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ResourceCache(root);
  const first = Buffer.from("owner alpha content"), second = Buffer.from("owner beta content");
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const firstId = hash(first), secondId = hash(second);
  assert.deepEqual(await store.findByOwner("missing"), []);
  await store.put("alpha", firstId, first);
  await store.put("beta", firstId, first);
  await store.put("beta", secondId, second);
  const indexDirectory = path.join(root, "resource-cache-index", hash(Buffer.from("alpha")));
  await fs.writeFile(path.join(indexDirectory, `${firstId}.json.partial`), "incomplete");
  await fs.writeFile(path.join(indexDirectory, "not-a-hash.json"), "ignored");
  await fs.mkdir(path.join(indexDirectory, `${secondId}.json`));
  const before = await resourceFixtureSnapshot(root);
  const expected = [{ id: firstId, bytes: first.length, sha256: firstId }];
  assert.deepEqual(await new ResourceCache(root).findByOwner("alpha"), expected);
  assert.deepEqual(await store.findByOwner("beta"), [
    { id: firstId, bytes: first.length, sha256: firstId },
    { id: secondId, bytes: second.length, sha256: secondId }
  ].sort((left, right) => left.id.localeCompare(right.id)));
  assert.deepEqual(await resourceFixtureSnapshot(root), before);
  const index = path.join(indexDirectory, `${firstId}.json`);
  const originalIndex = await fs.readFile(index);
  const reference = JSON.parse(originalIndex.toString("utf8")) as { file: string };
  await fs.writeFile(index, "{");
  await assert.rejects(store.findByOwner("alpha"), SyntaxError);
  await fs.writeFile(index, originalIndex);
  await fs.writeFile(reference.file, "corrupt");
  await assert.rejects(store.findByOwner("alpha"), /integrity check failed/);
  await fs.rm(reference.file);
  await assert.rejects(store.findByOwner("alpha"), { code: "ENOENT" });
  await assert.rejects(store.findByOwner(""), /Invalid resource identity/);
});

test("resource owner port uses the real cache, existing 1 MiB bound and write guards", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "resource-owner-port-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = ts.createSourceFile("controlPlaneRoutes.ts", await fs.readFile(new URL("./controlPlaneRoutes.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const matches: ts.PropertyAssignment[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === "resourceObjects") matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.equal(matches.length, 1);
  const body = ts.transpileModule(`return ${matches[0]!.initializer.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const createPort = new Function("resourceCache", "RESOURCE_OBJECT_MAX_BYTES", "managerReadOnly", body) as
    (cache: ResourceCache, max: number, readOnly: boolean) => { maxObjectBytes: number; read(owner: string, id: string): Promise<Buffer>;
      findByOwner(owner: string): Promise<readonly { id: string; bytes: number; sha256: string }[]>;
      put(owner: string, id: string, bytes: Uint8Array, authorize: () => void): Promise<unknown> };
  const cache = new ResourceCache(root), port = createPort(cache, RESOURCE_OBJECT_MAX_BYTES, false);
  const readOnlyPort = createPort(cache, RESOURCE_OBJECT_MAX_BYTES, true);
  assert.equal(port.maxObjectBytes, 1024 * 1024);
  const bytes = Buffer.alloc(port.maxObjectBytes, 1), id = createHash("sha256").update(bytes).digest("hex");
  let checks = 0;
  assert.throws(() => readOnlyPort.put("owner", id, bytes, () => { checks++; }), /read-only Manager/);
  assert.equal(checks, 1);
  assert.throws(() => port.put("owner", id, bytes, () => { throw new Error("denied"); }), /denied/);
  assert.deepEqual(await fs.readdir(root), []);
  let revocationChecks = 0;
  await assert.rejects(port.put("revoked", id, bytes, () => {
    if (++revocationChecks === 3) throw new Error("authorization revoked");
  }), /authorization revoked/);
  assert.deepEqual(await cache.findByOwner("revoked"), []);
  await port.put("owner", id, bytes, () => { checks++; });
  assert.deepEqual(await port.read("owner", id), bytes);
  assert.deepEqual(await port.findByOwner("owner"), [{ id, bytes: bytes.length, sha256: id }]);
  const oversize = Buffer.alloc(port.maxObjectBytes + 1, 2);
  await assert.rejects(port.put("owner", createHash("sha256").update(oversize).digest("hex"), oversize, () => {}), /size or checksum/);
});

test("durable resources survive path changes and restart; scope and checksum fail closed", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),"rabi-resource-"));
  t.after(() => fs.rm(dir,{recursive:true,force:true}));
  const store = new ResourceCache(dir);
  const bytes = Buffer.from("recording bytes"); const id=createHash("sha256").update(bytes).digest("hex");
  assert.equal((await store.put("phone-a",id,bytes)).durable,true);
  await store.configure(path.join(dir,"new"));
  assert.deepEqual(await new ResourceCache(dir).read("phone-a",id),bytes);
  await assert.rejects(store.read("phone-b",id));
  await assert.rejects(store.put("phone-a",id,Buffer.from("wrong")));
  await assert.rejects(store.configure("relative"));
  assert.deepEqual(await store.put("phone-a",id,bytes),{id,bytes:bytes.length,sha256:id,durable:true});
});

test("legacy directory updates preserve archive bindings and respect the shared settings lock", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-resource-bindings-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "resource-cache.json");
  const archiveBindings = { schemaVersion: 1, revision: 0, ownerRoleBindings: {} };
  await fs.writeFile(file, JSON.stringify({ archiveBindings }));
  const store = new ResourceCache(dir);
  assert.equal((await store.settings()).directory, path.join(dir, "resource-cache"));
  await store.configure(path.join(dir, "new"));
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")).archiveBindings, archiveBindings);
  await fs.writeFile(file + ".lock", "");
  await assert.rejects(store.configure(path.join(dir, "blocked")), { code: "EEXIST" });
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).directory, path.join(dir, "new"));
});

test("resource HTTP refuses untrusted requests and validates a complete round trip", async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"rabi-resource-http-"));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const handler=resourceCacheHandler(new ResourceCache(dir),{local:()=>false,tunnelKey:()=>"test-key",readOnly:()=>false});
  const server=http.createServer((req,res)=>handler(req,new URL(req.url!,"http://test"),res));
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const base=`http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const data=Buffer.from("media"); const id=createHash("sha256").update(data).digest("hex");
  const url=base+"/api/resource-cache/data/objects/"+id;
  assert.equal((await fetch(url)).status,403);
  const headers={"x-rabilink-resource-key":"test-key","x-rabilink-resource-owner":"phone"};
  assert.equal((await fetch(base+"/api/resource-cache/settings",{headers})).status,403);
  assert.equal((await fetch(url,{method:"PUT",headers,body:data})).status,200);
  assert.deepEqual(Buffer.from(await (await fetch(url,{headers})).arrayBuffer()),data);
  assert.equal((await fetch(url,{headers:{...headers,"x-rabilink-resource-owner":"other"}})).status,404);
});

function resourceResponse(handler: ReturnType<typeof resourceCacheHandler>, request: http.IncomingMessage) {
  return new Promise<{ status: number; body: any }>(resolve => {
    let status = 0;
    const response = { headersSent: false, writeHead(value: number) { status = value; },
      end(body: string) { resolve({ status, body: Buffer.isBuffer(body) ? body : JSON.parse(body) }); } } as unknown as http.ServerResponse;
    assert.equal(handler(request, new URL(request.url!, "http://fixture"), response), true);
  });
}

async function resourceAuthorityFixture(t: import("node:test").TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "resource-agent-fixture-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const config = new RabiGlobalConfigStore(root);
  config.patch({ webguiLan: { enabled: true } });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "fixture-node");
  const make = (method = "GET", url = "/api/resource-cache/settings", body = "", admitted = true) => {
    const request = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), { method, url,
      socket: { remoteAddress: "192.0.2.1" }, headers: { host: "fixture.invalid", authorization: `Bearer ${credential.token}`, "x-rabiroute-agent-id": "worker" } }) as unknown as http.IncomingMessage;
    if (admitted) assert.equal(evaluateLanAgentRequest(request, authority, true, () => config.getLanAgentAdmissionPolicy()).kind, "agent");
    return request;
  };
  const store = new ResourceCache(path.join(root, "state"));
  const handler = resourceCacheHandler(store, { local: () => true, tunnelKey: () => "fixture-key", readOnly: () => false });
  const revoke = () => { authority.enroll(authority.issueBootstrapTicket().ticket, "fixture-node", replacementCredentialBytes(32).toString("base64url")); };
  return { root, store, handler, make, revoke, config };
}

test("resource settings share real ingress authority, not headers or resource transport credentials", async t => {
  const { root, store, handler, make } = await resourceAuthorityFixture(t);
  assert.equal((await resourceResponse(handler, make())).status, 200);
  const directory = path.join(root, "configured");
  assert.equal((await resourceResponse(handler, make("PUT", undefined, JSON.stringify({ directory })))).status, 200);
  assert.equal((await new ResourceCache(path.join(root, "state")).settings()).directory, directory);
  const forged = make("GET", undefined, "", false);
  Object.assign(forged.socket, { remoteAddress: "127.0.0.1" });
  forged.headers.host = "127.0.0.1";
  assert.equal((await resourceResponse(handler, forged)).status, 200, "A legacy metadata header does not remove local authority.");
  const bytes = Buffer.from("private resource");
  const id = createHash("sha256").update(bytes).digest("hex");
  await store.put("owner", id, bytes);
  for (const method of ["GET", "PUT"]) {
    const request = make(method, `/api/resource-cache/data/objects/${id}`, bytes.toString());
    request.headers["x-rabilink-resource-owner"] = "owner";
    assert.equal((await resourceResponse(handler, request)).status, 200);
  }
  const local = make("GET", undefined, "", false);
  delete local.headers.authorization; delete local.headers["x-rabiroute-agent-id"];
  Object.assign(local.socket, { remoteAddress: "127.0.0.1" }); local.headers.host = "127.0.0.1";
  assert.equal((await resourceResponse(handler, local)).status, 200);
  local.headers.origin = "https://attacker.invalid";
  assert.equal((await resourceResponse(handler, local)).status, 403);
});

test("resource settings revalidate before disclosure and after streamed body without loopback ABA fallback", async t => {
  for (const globalAba of [false, true]) {
    const { store, handler, make, revoke, config } = await resourceAuthorityFixture(t);
    const request = make();
    const original = store.settings.bind(store);
    store.settings = async () => {
      const result = await original();
      if (globalAba) { config.patch({ webguiLan: { enabled: false } }); config.patch({ webguiLan: { enabled: true } }); }
      else revoke();
      Object.assign(request.socket, { remoteAddress: "127.0.0.1" }); request.headers.host = "127.0.0.1";
      return result;
    };
    const result = await resourceResponse(handler, request);
    assert.equal(result.status, 403); assert.equal(result.body.directory, undefined);
  }
  const { root, store, handler, make, revoke } = await resourceAuthorityFixture(t);
  const request = make("PUT");
  let configured = 0;
  const original = store.configure.bind(store);
  store.configure = async (...args) => { configured++; return original(...args); };
  request[Symbol.asyncIterator] = async function* () {
    yield Buffer.from(JSON.stringify({ directory: path.join(root, "denied") }));
    revoke(); Object.assign(request.socket, { remoteAddress: "127.0.0.1" }); request.headers.host = "127.0.0.1";
  };
  assert.equal((await resourceResponse(handler, request)).status, 403);
  assert.equal(configured, 0);
  await assert.rejects(fs.stat(path.join(root, "denied")), { code: "ENOENT" });
});

test("resource settings fence awaited temporary-file creation and fsync before publishing a replacement", async t => {
  for (const stage of ["open", "sync"]) {
    await t.test(stage, async t => {
      const { root, store, handler, make, revoke } = await resourceAuthorityFixture(t);
      await store.configure(path.join(root, "original"));
      const file = path.join(root, "state", "resource-cache.json");
      const previous = await fs.readFile(file, "utf8");
      const originalOpen = fs.open.bind(fs);
      t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args);
        if (String(args[0]).startsWith(file + ".") && String(args[0]).endsWith(".partial")) {
          if (stage === "open") revoke();
          else {
            const originalSync = handle.sync.bind(handle);
            t.mock.method(handle, "sync", async () => { await originalSync(); revoke(); });
          }
        }
        return handle;
      });
      const result = await resourceResponse(handler, make("PUT", undefined, JSON.stringify({ directory: path.join(root, "replacement") })));
      assert.equal(result.status, 403);
      assert.equal(await fs.readFile(file, "utf8"), previous);
      assert.deepEqual(await fs.readdir(path.join(root, "state")), ["resource-cache.json"]);
    });
  }
});
