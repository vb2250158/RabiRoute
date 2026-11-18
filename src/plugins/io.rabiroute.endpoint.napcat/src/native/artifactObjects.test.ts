import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { ResourceCache } from "../../../../manager/resourceCache.js";
import { RESOURCE_OBJECT_MAX_BYTES } from "../../../../manager/resourceCacheProtocol.js";
import { createProtectedResourceObjects } from "../../../../manager/protectedResourceObjects.js";
import { createAsyncLocalSecretProtector } from "../../../../shared/localSecretProtection.js";
import { NapcatArtifactObjects } from "./artifactObjects.js";
import { memoryResourceObjects } from "./artifactObjects.fixture.js";
const binding = { routeId: "route", instanceId: "instance", botUserId: "12345", action: "get_ai_record", deliveryId: "original-delivery", requestDigest: "a".repeat(64) };
test("a public-cache writer cannot forge a completed native generation manifest", async () => {
    const fixture = memoryResourceObjects();
    const owner = new NapcatArtifactObjects(fixture.resources, fixture.protectedResources);
    await owner.put(binding, Buffer.from("original"), "file.bin", () => {
    });
    const manifestKey = [...fixture.values.keys()].find(key => !key.includes(":chunks/"))!;
    const resourceOwner = manifestKey.slice(0, manifestKey.lastIndexOf("/"));
    fixture.values.delete(manifestKey);
    const forged = Buffer.from(JSON.stringify({ version: 1, requestDigest: binding.requestDigest, bytes: 0,
        sha256: createHash("sha256").update("").digest("hex"), name: "file.bin", mediaType: "application/octet-stream", chunks: [] }));
    await fixture.resources.put(resourceOwner, createHash("sha256").update(forged).digest("hex"), forged, () => {
    });
    await assert.rejects(owner.find(binding, 1000, () => {
    }), /protected resource envelope/i);
});
test("large native artifacts backpressure chunk persistence and stream reads without materializing the whole object", async () => {
    const fixture = memoryResourceObjects(1048576);
    let activeWrites = 0;
    let maxActiveWrites = 0;
    const resources = { ...fixture.resources, put: async (...args: Parameters<typeof fixture.resources.put>) => {
            activeWrites++;
            maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
            await new Promise(resolve => setImmediate(resolve));
            try {
                return await fixture.resources.put(...args);
            }
            finally {
                activeWrites--;
            }
        } };
    const owner = new NapcatArtifactObjects(resources, fixture.protectedResources);
    const expectedHash = createHash("sha256");
    const piece = Buffer.alloc(65537, 17);
    const reference = await owner.putStream(binding, async (write) => {
        for (let index = 0; index < 256; index++) {
            expectedHash.update(piece);
            await write(piece);
        }
    }, "native-file.bin", () => {
    });
    assert.equal(maxActiveWrites, 1);
    assert.equal(reference.bytes, piece.length * 256);
    assert.equal(reference.sha256, expectedHash.digest("hex"));
    assert.ok([...fixture.values.values()].every(bytes => bytes.length <= resources.maxObjectBytes));
    assert.deepEqual(await owner.find(binding, reference.bytes, () => {
    }), reference);
    const stream = await owner.openStream(binding, reference.resourceId, reference.bytes, () => {
    });
    const actualHash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of stream.frames) {
        actualHash.update(chunk);
        bytes += chunk.length;
        assert.ok(chunk.length <= resources.maxObjectBytes);
    }
    assert.equal(bytes, reference.bytes);
    assert.equal(actualHash.digest("hex"), reference.sha256);
});
test("shared artifact objects chunk within the original store bound and recover a complete manifest under the same owner", async () => {
    const fixture = memoryResourceObjects(), body = Buffer.alloc(9000, 7);
    const owner = new NapcatArtifactObjects(fixture.resources, fixture.protectedResources);
    const reference = await owner.put(binding, body, "ai-voice.silk", () => {
    });
    assert.equal(fixture.values.size, 3, "Identical full chunks reuse the same content-addressed object.");
    assert.ok([...fixture.values.values()].every(bytes => bytes.length <= fixture.resources.maxObjectBytes));
    assert.deepEqual((await owner.read(binding, reference.resourceId, 10000, () => {
    })).bytes, body);
    assert.deepEqual(await new NapcatArtifactObjects(fixture.resources, fixture.protectedResources).find(binding, 10000, () => {
    }), reference);
    assert.equal(await owner.find({ ...binding, botUserId: "67890" }, 10000, () => {
    }), undefined);
    await assert.rejects(owner.find({ ...binding, requestDigest: "b".repeat(64) }, 10000, () => {
    }), { code: "QQ_NATIVE_RESOURCE_INTENT_CONFLICT" });
});
test("partial artifact objects never become proof of a completed native generation", async () => {
    const fixture = memoryResourceObjects(), originalPut = fixture.resources.put;
    const resources = { ...fixture.resources, put: async (...args: Parameters<typeof originalPut>) => {
            if (!args[0].endsWith(":chunks"))
                throw new Error("Fixture manifest publication failed");
            return originalPut(...args);
        } };
    const owner = new NapcatArtifactObjects(resources, { ...fixture.protectedResources, putProtected: async () => {
            throw Error("Fixture manifest publication failed");
        } });
    await assert.rejects(owner.put(binding, Buffer.alloc(3000, 9), "ai-voice.silk", () => {
    }), /publication failed/);
    assert.ok(fixture.values.size > 0);
    assert.equal(await owner.find(binding, 4000, () => {
    }), undefined);
});
test("artifact reads retain byte quotas, cancellation, full integrity and legitimate empty files", async () => {
    const fixture = memoryResourceObjects(), owner = new NapcatArtifactObjects(fixture.resources, fixture.protectedResources);
    const reference = await owner.put(binding, Buffer.alloc(3000, 5), "file.bin", () => {
    });
    await assert.rejects(owner.read(binding, reference.resourceId, 2000, () => {
    }), { code: "QQ_NATIVE_RESOURCE_TOO_LARGE" });
    await assert.rejects(owner.read(binding, reference.resourceId, 4000, () => {
        throw new Error("Original request revoked");
    }), /revoked/);
    const key = [...fixture.values.keys()].find(value => value.includes(":chunks/"))!;
    fixture.values.set(key, Buffer.from("corrupt"));
    await assert.rejects(owner.find(binding, 4000, () => {
    }), /integrity/);
    const emptyBinding = { ...binding, deliveryId: "empty-file" };
    const empty = await owner.put(emptyBinding, Buffer.alloc(0), "file.bin", () => {
    });
    assert.equal((await owner.read(emptyBinding, empty.resourceId, 0, () => {
    })).bytes.length, 0);
});
test("the real shared ResourceCache survives a fresh artifact owner and verifies all native result chunks", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "napcat-artifact-shared-cache-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const ports = (cache: ResourceCache) => ({ maxObjectBytes: RESOURCE_OBJECT_MAX_BYTES,
        put: cache.put.bind(cache), read: cache.read.bind(cache), findByOwner: cache.findByOwner.bind(cache) });
    const bytes = Buffer.alloc(RESOURCE_OBJECT_MAX_BYTES * 2 + 128, 5);
    const originalCache = new ResourceCache(root);
    const original = new NapcatArtifactObjects(ports(originalCache), createProtectedResourceObjects(originalCache, createAsyncLocalSecretProtector(root), "message-endpoint-private-metadata@1"));
    const reference = await original.put(binding, bytes, "ai-voice.silk", () => {
    });
    const restoredCache = new ResourceCache(root);
    const restored = new NapcatArtifactObjects(ports(restoredCache), createProtectedResourceObjects(restoredCache, createAsyncLocalSecretProtector(root), "message-endpoint-private-metadata@1"));
    assert.deepEqual(await restored.find(binding, bytes.length, () => {
    }), reference);
    assert.deepEqual((await restored.read(binding, reference.resourceId, bytes.length, () => {
    })).bytes, bytes);
    assert.equal(await restored.find({ ...binding, instanceId: "other-instance" }, bytes.length, () => {
    }), undefined);
});
