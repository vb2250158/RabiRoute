import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import http from "node:http";
import { ResourceCache, resourceCacheHandler } from "./resourceCache.js";

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
