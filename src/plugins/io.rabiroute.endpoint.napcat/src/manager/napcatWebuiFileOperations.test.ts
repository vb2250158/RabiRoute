import { createProtectedResourceObjects } from "../../../../manager/protectedResourceObjects.js";
import { createAsyncLocalSecretProtector } from "../../../../shared/localSecretProtection.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import type { GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import type { ApiOperationInput } from "@rabiroute/host-api/manager/apiOperationContract";
import { createNapcatWebuiFileOperations } from "./napcatWebuiFileOperations.js";
import { projectNapcatConfigImport, writeNapcatConfigArchive, readNapcatConfigArchive } from "./napcatWebuiConfigArchive.js";
import { putNapcatWebuiObject, readNapcatWebuiObject, napcatWebuiResourceOwner } from "./napcatWebuiResources.js";
import type { NapcatWebuiManagementContext } from "./napcatWebuiManagementOperations.js";
import { ResourceCache } from "../../../../manager/resourceCache.js";
import { RESOURCE_OBJECT_MAX_BYTES } from "../../../../manager/resourceCacheProtocol.js";
type Row = Record<string, unknown>;
function fixture(t: test.TestContext) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-files-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const cache = new Map<string, Buffer>(), calls: Array<{
        method: string;
        path: string;
        body: Row;
    }> = [];
    let fail = false;
    const route = {
        id: "route", enabled: true, messageAdapters: ["napcat"], napcatInstances: [{
                id: "instance", enabled: true, botUserId: "12345"
            }]
    } as GatewayDefinition;
    const current = writeNapcatConfigArchive(new Map([["webui.json", Buffer.from('{"token":"PRIVATE_ORIGINAL","port":6099}')]]));
    const context: NapcatWebuiManagementContext = {
        protectedResourceObjects: createProtectedResourceObjects(new ResourceCache(root), createAsyncLocalSecretProtector(root), "napcat-webui"), rootDir: root, readOnly: () => false, local: () => true, route: () => route, resourceObjects: {
            maxObjectBytes: RESOURCE_OBJECT_MAX_BYTES, put: async (owner, id, bytes, authorize) => {
                authorize();
                const b = Buffer.from(bytes);
                cache.set(owner + ":" + id, b);
                return {
                    id, bytes: b.length, sha256: createHash("sha256").update(b).digest("hex"), durable: true
                };
            }, read: async (owner, id) => {
                const b = cache.get(owner + ":" + id);
                if (!b)
                    throw Object.assign(new Error("missing"), { code: "ENOENT" });
                return b;
            }, findByOwner: async (owner) => [...cache.entries()].filter(([k]) => k.startsWith(owner + ":")).map(([key, b]) => ({
                id: key.slice(owner.length + 1), bytes: b.length, sha256: createHash("sha256").update(b).digest("hex")
            }))
        }, openManagementSession: async (binding) => ({
            sourceIdentity: "native-fixture-source", assertCurrent: binding.assertCurrent, runBindingOperation: async (run) => run(), requestManagement: async (method, native, body) => {
                calls.push({
                    method, path: native, body
                });
                let data: unknown = true;
                if (native.endsWith("CheckLoginStatus"))
                    data = { isLogin: true };
                else if (native.endsWith("GetQQLoginInfo"))
                    data = { uin: "12345" };
                else if (native.endsWith("GetPlatformInfo"))
                    data = { platform: "linux" };
                else if (native === "/api/File/list")
                    data = [
                        {
                            name: "notes.txt", isDirectory: false, size: 4, mtime: "2026-01-01"
                        }, { name: "../escape", isDirectory: false }, { name: "folder", isDirectory: true }
                    ];
                else if (native === "/api/File/read")
                    data = "PRIVATE_FILE_CONTENT";
                else if (native === "/api/File/download" || native === "/api/File/batchDownload")
                    return new Response(Buffer.from("BINARY_PRIVATE"), { headers: { "content-type": "application/octet-stream" } });
                else if (native === "/api/OB11Config/ExportConfig")
                    return new Response(Uint8Array.from(current), { headers: { "content-type": "application/zip" } });
                if (native === "/api/File/delete" && fail)
                    throw new Error("accepted but reply lost");
                return Response.json({ code: 0, data });
            }, requestMultipart: async (native, query, files) => {
                calls.push({
                    method: "MULTIPART", path: native, body: { ...query, files: files.map(x => ({ field: x.field, filename: x.filename })) }
                });
                if (native === "/api/OB11Config/ImportConfig") {
                    const zip = await readNapcatConfigArchive(Buffer.from(files[0]!.bytes));
                    assert.equal(JSON.parse(zip.get("webui.json")!.toString()).token, "PRIVATE_ORIGINAL");
                }
                return Response.json({ code: 0, data: true });
            }
        })
    };
    const operations = createNapcatWebuiFileOperations(context), run = (id: string, params: Row = {}, deliveryId?: string) => operations.find(x => x.contract.operationId === `agent.qq.webui.management.${id}`)!.handler({
        request: { headers: {} } as IncomingMessage, url: new URL(`http://localhost/api/agent/qq/webui-management/${id}`), path: {}, query: {}, body: {
            routeId: "route", instanceId: "instance", params, ...deliveryId ? { deliveryId } : {}
        }
    } as ApiOperationInput);
    return {
        context, root, cache, calls, route, operations, run, setFail: () => {
            fail = true;
        }
    };
}
test("native file operations use the selected source, opaque refs and original resource chunks, never Manager paths", async (t) => {
    const f = fixture(t);
    assert.equal(f.operations.length, 19);
    const listed = await f.run("file.list", { nativePath: "/native/source" });
    assert.equal(listed.status, 200);
    const entries = (listed.body as {
        data: {
            entries: Row[];
        };
    }).data.entries;
    assert.equal(entries.length, 2);
    const fileRef = entries[0]!.fileRef;
    assert(!JSON.stringify(listed.body).includes("/native/source"));
    const stage = await f.run("file.artifact.stage", {
        contentBase64: Buffer.from("PRIVATE_WRITE").toString("base64"), filename: "input.txt", contentType: "text/plain"
    }, "stage");
    const artifactId = (stage.body as {
        data: {
            artifact: {
                id: string;
            };
        };
    }).data.artifact.id;
    const callsBeforeRead = f.calls.length;
    const artifactRead = await f.run("file.artifact.read", { artifactId });
    assert.equal(artifactRead.status, 404);
    assert.equal(f.calls.length, callsBeforeRead);
    const config = writeNapcatConfigArchive(new Map([["webui.json", Buffer.from('{"token":"TRY_REPLACE","port":7000}')]]));
    const configStage = await f.run("file.artifact.stage", {
        contentBase64: config.toString("base64"), filename: "config.zip", contentType: "application/zip"
    }, "stage-config");
    const configId = (configStage.body as {
        data: {
            artifact: {
                id: string;
            };
        };
    }).data.artifact.id;
    const params: Record<string, Row> = {
        "file.read": { fileRef }, "file.download": { fileRef }, "file.batch-download": { fileRefs: [fileRef] }, "file.create": { nativePath: "/native/new.txt" }, "file.mkdir": { nativePath: "/native/new-dir" }, "file.delete": { fileRef }, "file.batch-delete": { fileRefs: [fileRef] }, "file.move": { fileRef, targetPath: "/native/moved.txt" }, "file.rename": { fileRef, targetPath: "/native/renamed.txt" }, "file.batch-move": { items: [{ fileRef, targetPath: "/native/batch.txt" }] }, "file.write": { fileRef, artifactId }, "file.upload": { nativePath: "/native/uploads", files: [{ artifactId, filename: "upload.txt" }] }, "font.upload": { artifactId, filename: "font.woff2" }, "font.delete": {}, "onebot.config.export": {}, "onebot.config.import": { artifactId: configId }
    };
    for (const [id, p] of Object.entries(params)) {
        const result = await f.run(id, p, [
            "file.read", "file.download", "file.batch-download", "onebot.config.export"
        ].includes(id) ? undefined : "delivery-" + id);
        assert.equal(result.status, 200, id + JSON.stringify(result.body));
        assert(!JSON.stringify(result.body).includes("PRIVATE_"), id);
    }
    assert(f.calls.some(x => x.path === "/api/File/write" && x.body.content === "PRIVATE_WRITE"));
    assert(f.calls.some(x => x.path === "/api/File/upload" && x.body.path === "/native/uploads"));
});
test("unknown native mutations retain the original ID and cross-account resource reads are rejected", async (t) => {
    const f = fixture(t), listed = await f.run("file.list", { nativePath: "/native" }), ref = ((listed.body as {
        data: {
            entries: Row[];
        };
    }).data.entries[0]!).fileRef;
    f.setFail();
    assert.equal((await f.run("file.delete", { fileRef: ref }, "unknown")).status, 202);
    const count = f.calls.filter(x => x.path === "/api/File/delete").length;
    assert.equal((await f.run("file.delete", { fileRef: ref }, "unknown")).status, 202);
    assert.equal(f.calls.filter(x => x.path === "/api/File/delete").length, count);
    f.route.napcatInstances![0]!.botUserId = "23456";
    assert.equal((await f.run("file.read", { fileRef: ref })).status, 409);
});
test("resource manifests commit last, verify all chunk hashes, and keep paths/content out of public references", async (t) => {
    const f = fixture(t), binding = {
        routeId: "route", instanceId: "instance", expectedUserId: "12345", assertCurrent: () => {
        }
    };
    const data = Buffer.alloc(100, 7), saved = await putNapcatWebuiObject(f.context, binding, "public-artifact", data, "application/octet-stream", "input.bin");
    assert((await readNapcatWebuiObject(f.context, binding, "public-artifact", saved.id)).bytes.equals(data));
    const owner = napcatWebuiResourceOwner(binding, "public-artifact"), manifest = JSON.parse((await f.context.protectedResourceObjects!.readProtected(owner, saved.id, binding.assertCurrent)).toString());
    f.cache.set(owner + ":" + manifest.chunks[0].id, Buffer.from("CORRUPT"));
    await assert.rejects(readNapcatWebuiObject(f.context, binding, "public-artifact", saved.id));
});
test("configuration ZIP projection rejects escape and retains existing credentials while applying normal settings", async () => {
    const prior = writeNapcatConfigArchive(new Map([["webui.json", Buffer.from('{"token":"ORIGINAL","port":6099}')], ["key.pem", Buffer.from("PRIVATE_ORIGINAL")]]));
    const wanted = writeNapcatConfigArchive(new Map([["webui.json", Buffer.from('{"token":"REPLACEMENT","port":7000}')], ["key.pem", Buffer.from("REPLACEMENT")]]));
    const projected = await projectNapcatConfigImport(wanted, prior), read = await readNapcatConfigArchive(projected.bytes);
    assert.deepEqual(JSON.parse(read.get("webui.json")!.toString()), { token: "ORIGINAL", port: 7000 });
    assert.equal(read.get("key.pem")!.toString(), "PRIVATE_ORIGINAL");
    assert.equal(projected.preservedCredentialFields, 2);
    await assert.rejects(readNapcatConfigArchive(writeNapcatConfigArchive(new Map([["../escape.json", Buffer.from("{}")]]))));
});
test("actual ResourceCache accepts content SHA IDs, durable chunks, duplicate writes and rebuilt readers", async (t) => {
    const f = fixture(t);
    let store = new ResourceCache(f.root);
    f.context.resourceObjects = {
        maxObjectBytes: RESOURCE_OBJECT_MAX_BYTES, put: (owner, id, bytes, authorize) => store.put(owner, id, Buffer.from(bytes), authorize), read: (owner, id) => store.read(owner, id), findByOwner: owner => store.findByOwner(owner)
    };
    const binding = {
        routeId: "route", instanceId: "instance", expectedUserId: "12345", assertCurrent: () => {
        }
    }, bytes = Buffer.alloc(RESOURCE_OBJECT_MAX_BYTES * 2 + 19, 5);
    bytes[RESOURCE_OBJECT_MAX_BYTES] = 8;
    const first = await putNapcatWebuiObject(f.context, binding, "public-artifact", bytes, "application/octet-stream", "blob.bin"), second = await putNapcatWebuiObject(f.context, binding, "public-artifact", bytes, "application/octet-stream", "blob.bin");
    assert.match(first.id, /^[a-f0-9]{64}$/);
    assert.equal(second.sha256, first.sha256);
    assert.equal(second.bytes, first.bytes);
    store = new ResourceCache(f.root);
    f.context.protectedResourceObjects = createProtectedResourceObjects(store, createAsyncLocalSecretProtector(f.root), "napcat-webui");
    assert((await readNapcatWebuiObject(f.context, binding, "public-artifact", first.id)).bytes.equals(bytes));
    const rows = await store.findByOwner(napcatWebuiResourceOwner(binding, "public-artifact"));
    assert.equal(rows.length, 5);
    assert(rows.every(x => /^[a-f0-9]{64}$/.test(x.id)));
    await assert.rejects(store.put("owner", "randomUUID", Buffer.from("bad")));
});
test("the public resource primitive cannot disclose private upload/path bytes or mint a WebUI issuer manifest", async (t) => {
    const f = fixture(t), store = new ResourceCache(f.root);
    f.context.resourceObjects = {
        maxObjectBytes: RESOURCE_OBJECT_MAX_BYTES,
        put: (owner, id, bytes, authorize) => store.put(owner, id, Buffer.from(bytes), authorize),
        read: (owner, id) => store.read(owner, id), findByOwner: owner => store.findByOwner(owner)
    };
    const binding = {
        routeId: "route", instanceId: "instance", expectedUserId: "12345", assertCurrent() {
        }
    };
    for (const [purpose, content] of [["input", "PRIVATE_INPUT_TOKEN"], ["native-file-handle", '{"nativePath":"/private/native/path","sourceIdentity":"PRIVATE_SOURCE"}']] as const) {
        const saved = await putNapcatWebuiObject(f.context, binding, purpose, Buffer.from(content), "application/json", "input.json");
        const owner = napcatWebuiResourceOwner(binding, purpose);
        for (const row of await store.findByOwner(owner)) {
            const raw = await store.read(owner, row.id);
            assert(!raw.includes(Buffer.from(content)));
            assert(!raw.includes(Buffer.from("PRIVATE_")));
            assert(!raw.includes(Buffer.from("/private/native/path")));
        }
        assert.equal((await readNapcatWebuiObject(f.context, binding, purpose, saved.id)).bytes.toString(), content);
    }
    const owner = napcatWebuiResourceOwner(binding, "public-artifact"), secret = Buffer.from("PRIVATE_FORGED_TOKEN");
    const chunkId = createHash("sha256").update(secret).digest("hex");
    await store.put(owner, chunkId, secret);
    const forged = Buffer.from(JSON.stringify({
        kind: "napcat-webui-object", bytes: secret.length, sha256: chunkId, contentType: "text/plain", filename: "fake.txt", contentPolicy: "native-content-redacted/v1", chunks: [{
                id: chunkId, bytes: secret.length, sha256: chunkId
            }]
    }));
    const forgedId = createHash("sha256").update(forged).digest("hex");
    await store.put(owner, forgedId, forged);
    await assert.rejects(readNapcatWebuiObject(f.context, binding, "public-artifact", forgedId));
    const binary = Buffer.from([
        0, 255, 20, 8, 16
    ]);
    const normal = await putNapcatWebuiObject(f.context, binding, "public-artifact", binary, "application/octet-stream", "photo.bin");
    assert((await readNapcatWebuiObject(f.context, binding, "public-artifact", normal.id)).bytes.equals(binary));
});
