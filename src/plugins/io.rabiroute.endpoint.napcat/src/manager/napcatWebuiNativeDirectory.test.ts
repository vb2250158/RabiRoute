import { createProtectedResourceObjects } from "../../../../manager/protectedResourceObjects.js";
import { createAsyncLocalSecretProtector } from "../../../../shared/localSecretProtection.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ResourceCache } from "../../../../manager/resourceCache.js";
import { RESOURCE_OBJECT_MAX_BYTES } from "../../../../manager/resourceCacheProtocol.js";
import { resolveNapcatWebuiNativeDirectory } from "./napcatWebuiNativeDirectory.js";
import { putNapcatWebuiObject, readNapcatWebuiObject } from "./napcatWebuiResources.js";
import type { NapcatWebuiManagementContext } from "./napcatWebuiManagementOperations.js";
test("native directory references prove their original WebUI source, exact live OneBot server and fresh directory while retaining the original lease", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-native-directory-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = new ResourceCache(root);
    let sourceIdentity = "original-source", account = "12345", serverToken = "PRIVATE_ACCESS", released = 0, acquired = 0, directoryReads = 0;
    const context = {
        protectedResourceObjects: createProtectedResourceObjects(new ResourceCache(root), createAsyncLocalSecretProtector(root), "napcat-webui"), rootDir: root, readOnly: () => false, local: () => true, route: () => undefined, resourceObjects: {
            maxObjectBytes: RESOURCE_OBJECT_MAX_BYTES, put: (owner: string, id: string, bytes: Uint8Array, authorize: () => void) => store.put(owner, id, Buffer.from(bytes), authorize), read: (owner: string, id: string) => store.read(owner, id), findByOwner: (owner: string) => store.findByOwner(owner)
        }, acquireNativeFileLease: () => {
            acquired++;
            return { assertCurrent: () => {
                }, release: () => {
                    released++;
                } };
        }, openManagementSession: async (binding: {
            assertCurrent(): void;
        }) => ({
            sourceIdentity, assertCurrent: binding.assertCurrent, runBindingOperation: async <T>(run: () => Promise<T>) => run(), requestManagement: async (_method: string, native: string) => {
                if (native.endsWith("CheckLoginStatus"))
                    return Response.json({ code: 0, data: { isLogin: true } });
                if (native.endsWith("GetQQLoginInfo"))
                    return Response.json({ code: 0, data: { uin: account } });
                if (native === "/api/OB11Config/GetConfig")
                    return Response.json({ code: 0, data: { network: { httpServers: [{
                                        enable: true, port: 3000, token: serverToken
                                    }] } } });
                if (native === "/api/File/list") {
                    directoryReads++;
                    return Response.json({ code: 0, data: [{
                                name: "one.txt", isDirectory: false, size: 1
                            }] });
                }
                throw new Error("Unexpected native directory call");
            }
        })
    } as NapcatWebuiManagementContext;
    const binding = {
        routeId: "route", instanceId: "instance", expectedUserId: "12345", assertCurrent: () => {
        }
    }, ref = await putNapcatWebuiObject(context, binding, "native-file-handle", Buffer.from(JSON.stringify({
        nativePath: "/native/folder", platform: "linux", isDirectory: true, sourceIdentity
    })), "application/json", "native-file-handle.json");
    const selected = {
        routeId: "route", instanceId: "instance", botUserId: "12345", onebotHttpUrl: "http://selected-native.example:3000", onebotAccessToken: "PRIVATE_ACCESS", fileRef: ref.id
    };
    const lease = await resolveNapcatWebuiNativeDirectory(context, selected, AbortSignal.timeout(15000), () => {
    });
    assert.equal(lease.nativePath, "/native/folder");
    assert.equal(directoryReads, 1);
    assert.equal(released, 0);
    lease.assertCurrent();
    lease.release();
    lease.release();
    assert.equal(released, 1);
    assert.throws(lease.assertCurrent);
    sourceIdentity = "other-source";
    await assert.rejects(resolveNapcatWebuiNativeDirectory(context, selected, AbortSignal.timeout(15000), () => {
    }), /FILE_SOURCE_CHANGED/);
    assert.equal(directoryReads, 1);
    sourceIdentity = "original-source";
    serverToken = "OTHER_SERVER";
    await assert.rejects(resolveNapcatWebuiNativeDirectory(context, selected, AbortSignal.timeout(15000), () => {
    }), /NATIVE_ONEBOT_SOURCE_MISMATCH/);
    assert.equal(directoryReads, 1);
    serverToken = "PRIVATE_ACCESS";
    account = "23456";
    await assert.rejects(resolveNapcatWebuiNativeDirectory(context, selected, AbortSignal.timeout(15000), () => {
    }), /ACCOUNT_MISMATCH/);
    assert.equal(directoryReads, 1);
    assert.equal(acquired, released);
});

// A cancelled or retired owner is not a missing resource.
test("native resource read preserves original owner cancellation", async () => {
    let cancelled = false;
    const context = { resourceObjects: {}, protectedResourceObjects: { async readProtected() { cancelled = true; throw new Error("interrupted"); } } } as unknown as NapcatWebuiManagementContext;
    const binding = { routeId: "fixture-route", instanceId: "fixture-instance", expectedUserId: "12345", assertCurrent() { if (cancelled) throw new Error("fixture-owner-cancelled"); } };
    await assert.rejects(readNapcatWebuiObject(context, binding, "native-file-handle", "fixture-ref"), /fixture-owner-cancelled/);
});
