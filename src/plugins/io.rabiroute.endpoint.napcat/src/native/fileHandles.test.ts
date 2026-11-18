import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { NapcatNativeFileHandles } from "./fileHandles.js";
import { memoryResourceObjects } from "./artifactObjects.fixture.js";
import type { NapcatApiSelection } from "../manager/napcatApiTransport.js";

/** Fixed dummy value for injected offline test transports; never a real account credential. */
const fixtureAccessToken = "fixture-secret";

const selection: NapcatApiSelection = { routeId: "route", instanceId: "instance", botUserId: "12345", httpUrl: "http://fixture.invalid",
    accessToken: fixtureAccessToken, assertCurrent() {
    } };
const metadata = { nativePath: "C:/native-only/private-cache/file", requestDigest: "a".repeat(64), bytes: 7, sha256: "b".repeat(64), name: "file.bin" };
test("native file handles use the original cache and keep paths and service credentials out of the public reference", async () => {
    const store = memoryResourceObjects();
    const owner = new NapcatNativeFileHandles(store.protectedResources);
    const reference = await owner.put(selection, "download_file", "original-intent", metadata);
    assert.doesNotMatch(JSON.stringify(reference), /C:|private-cache|fixture-secret/);
    const fresh = new NapcatNativeFileHandles(store.protectedResources);
    assert.equal((await fresh.read(selection, reference)).nativePath, metadata.nativePath);
    assert.deepEqual(await fresh.findOriginal(selection, "download_file", "original-intent", metadata.requestDigest), reference);
});
test("a different QQ/native endpoint or original request cannot reuse a native file handle", async () => {
    const store = memoryResourceObjects();
    const owner = new NapcatNativeFileHandles(store.protectedResources);
    const reference = await owner.put(selection, "upload_file_stream", "original-intent", metadata);
    await assert.rejects(owner.read({ ...selection, botUserId: "54321" }, reference));
    await assert.rejects(owner.read({ ...selection, httpUrl: "http://other-native.invalid" }, reference));
    await assert.rejects(owner.read(selection, reference, "0".repeat(64)), /QQ_NATIVE_FILE_METADATA_INVALID/);
});
test("public cache reads reveal no native path and public writes cannot issue a native file handle", async () => {
    const store = memoryResourceObjects();
    const owner = new NapcatNativeFileHandles(store.protectedResources);
    await owner.put(selection, "download_file", "original-intent", metadata);
    for (const bytes of store.values.values())
        assert.doesNotMatch(bytes.toString(), /native-only|private-cache|fixture-secret/);
    const key = [...store.values.keys()][0];
    const resourceOwner = key.slice(0, key.lastIndexOf("/"));
    const forged = Buffer.from(JSON.stringify({ version: 1, action: "download_file", deliveryId: "original-intent", ...metadata }));
    const id = createHash("sha256").update(forged).digest("hex");
    await store.resources.put(resourceOwner, id, forged, () => {
    });
    await assert.rejects(owner.read(selection, { id, action: "download_file", deliveryId: "original-intent" }), /protected resource envelope/i);
});
