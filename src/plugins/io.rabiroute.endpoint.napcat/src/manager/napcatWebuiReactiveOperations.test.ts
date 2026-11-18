import { createProtectedResourceObjects } from "../../../../manager/protectedResourceObjects.js";
import { createAsyncLocalSecretProtector } from "../../../../shared/localSecretProtection.js";
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { IncomingMessage } from "node:http";
import type { GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import type { ApiOperationInput } from "@rabiroute/host-api/manager/apiOperationContract";
import { createNapcatWebuiReactiveOwner } from "./napcatWebuiReactiveOperations.js";
import type { NapcatWebuiManagementContext } from "./napcatWebuiManagementOperations.js";
import { ResourceCache } from "../../../../manager/resourceCache.js";
import { RESOURCE_OBJECT_MAX_BYTES } from "../../../../manager/resourceCacheProtocol.js";
// Synthetic fixture value; no account credential is used.
const fixturePassword = "PRIVATE_CONFIG";
test("reactive plugin controller retains native session ownership, idempotent original changes and cleanup", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-reactive-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    let cleaned = 0, opened = 0, changed = 0;
    let nativeController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const route = {
        id: "route", enabled: true, messageAdapters: ["napcat"], napcatInstances: [{
                id: "instance", enabled: true, botUserId: "12345"
            }]
    } as GatewayDefinition;
    const context: NapcatWebuiManagementContext = {
        resourceObjects: (() => {
            const store = new ResourceCache(root);
            return {
                maxObjectBytes: RESOURCE_OBJECT_MAX_BYTES, put: (owner: string, id: string, bytes: Uint8Array, authorize: () => void) => store.put(owner, id, Buffer.from(bytes), authorize), read: (owner: string, id: string) => store.read(owner, id), findByOwner: (owner: string) => store.findByOwner(owner)
            };
        })(),
        protectedResourceObjects: createProtectedResourceObjects(new ResourceCache(root), createAsyncLocalSecretProtector(root), "napcat-webui"), rootDir: root, readOnly: () => false, local: () => true, route: () => route, openManagementSession: async (binding) => ({
            assertCurrent: binding.assertCurrent, runBindingOperation: async (run) => run(), requestManagement: async (method, native, body, signal) => {
                if (native === "/api/QQLogin/CheckLoginStatus")
                    return Response.json({ code: 0, data: { isLogin: true } });
                if (native === "/api/QQLogin/GetQQLoginInfo")
                    return Response.json({ code: 0, data: { uin: "12345" } });
                if (native === "/api/Plugin/Config/Change") {
                    changed++;
                    assert.equal(body.sessionId, "PRIVATE_NATIVE_SESSION");
                    nativeController!.enqueue(Buffer.from('event: schema\ndata: {"type":"full","schema":[{"secret":"PRIVATE_CONFIG"}]}\n\n'));
                    return Response.json({ code: 0, data: { message: "PRIVATE_NATIVE" } });
                }
                assert.equal(method, "GET");
                assert.equal(native, "/api/Plugin/Config/SSE");
                opened++;
                return new Response(new ReadableStream<Uint8Array>({ start(c) {
                        nativeController = c;
                        c.enqueue(Buffer.from('event: connected\ndata: {"sessionId":"PRIVATE_NATIVE_SESSION"}\n\n'));
                        signal.addEventListener("abort", () => {
                            cleaned++;
                            c.close();
                        }, { once: true });
                    }, cancel() {
                    } }), { headers: { "content-type": "text/event-stream" } });
            }
        })
    };
    const owner = createNapcatWebuiReactiveOwner(context);
    t.after(() => owner.dispose());
    const openingController = new AbortController();
    const run = (id: string, params: Record<string, unknown>, deliveryId?: string) => owner.operations.find(x => x.contract.operationId === `agent.qq.webui.management.${id}`)!.handler({
        ...(id.endsWith(".open") && !openingController.signal.aborted ? { signal: openingController.signal } : {}),
        request: { headers: {} } as IncomingMessage, url: new URL(`http://localhost/api/agent/qq/webui-management/${id}`), path: {}, query: {}, body: {
            routeId: "route", instanceId: "instance", params, ...deliveryId ? { deliveryId } : {}
        }
    } as ApiOperationInput);
    const openedResult = await run("plugin.config.events.open", { id: "fixture", initialConfig: { password: fixturePassword } }, "open");
    assert.equal(openedResult.status, 200);
    openingController.abort();
    assert.equal(cleaned, 0, "a completed opening HTTP request does not retire the activation-owned stream");
    const leaseId = (openedResult.body as {
        data: {
            leaseId: string;
        };
    }).data.leaseId;
    assert(!JSON.stringify(openedResult.body).includes("PRIVATE_"));
    assert.equal((await run("plugin.config.events.open", { id: "fixture", initialConfig: { password: fixturePassword } }, "open")).status, 200);
    assert.equal(opened, 1);
    assert.equal((await run("plugin.config.change", {
        leaseId, key: "enabled", value: true, currentConfig: { enabled: true }
    }, "change")).status, 200);
    assert.equal((await run("plugin.config.change", {
        leaseId, key: "enabled", value: true, currentConfig: { enabled: true }
    }, "change")).status, 200);
    assert.equal(changed, 1);
    const read = await run("plugin.config.events.read", { leaseId });
    assert.equal(read.status, 200);
    assert(!JSON.stringify(read.body).includes("PRIVATE_"));
    assert.equal((await run("plugin.config.change", {
        leaseId: "PRIVATE_NATIVE_SESSION", key: "enabled", value: false, currentConfig: {}
    }, "forged")).status, 404);
    const close = await run("plugin.config.events.close", { leaseId }, "close");
    assert.equal(close.status, 200);
    assert.equal(cleaned, 1);
    assert.equal((await run("plugin.config.events.read", { leaseId })).status, 404);
});
test("retirement aborts pending native opens, rejects late registration and joins actual reader cancellation", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-reactive-retirement-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const deferred = <T>() => {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>(done => resolve = done);
        return { promise, resolve };
    };
    const started = deferred<void>(), responseGate = deferred<void>(), cancelStarted = deferred<void>(), cancelGate = deferred<void>();
    let nativeSignal: AbortSignal | undefined, calls = 0;
    const route = {
        id: "route", enabled: true, messageAdapters: ["napcat"], napcatInstances: [{
                id: "instance", enabled: true, botUserId: "12345"
            }]
    } as GatewayDefinition;
    const context: NapcatWebuiManagementContext = {
        protectedResourceObjects: createProtectedResourceObjects(new ResourceCache(root), createAsyncLocalSecretProtector(root), "napcat-webui"), rootDir: root, readOnly: () => false, local: () => true, route: () => route, openManagementSession: async (binding) => ({
            assertCurrent: binding.assertCurrent, runBindingOperation: async (run) => run(), requestManagement: async (_method, native, _body, signal) => {
                calls++;
                if (native.endsWith("CheckLoginStatus"))
                    return Response.json({ code: 0, data: { isLogin: true } });
                if (native.endsWith("GetQQLoginInfo"))
                    return Response.json({ code: 0, data: { uin: "12345" } });
                nativeSignal = signal;
                started.resolve();
                await responseGate.promise;
                return new Response(new ReadableStream<Uint8Array>({ start(controller) {
                        controller.enqueue(Buffer.from('event: connected\ndata: {"sessionId":"PRIVATE_SESSION"}\n\n'));
                    }, async cancel() {
                        cancelStarted.resolve();
                        await cancelGate.promise;
                    } }), { headers: { "content-type": "text/event-stream" } });
            }
        })
    };
    const owner = createNapcatWebuiReactiveOwner(context), operation = owner.operations.find(item => item.contract.operationId.endsWith("events.open"))!;
    const input = {
        request: { headers: {} } as IncomingMessage, url: new URL("http://localhost/api/agent/qq/webui-management/plugin.config.events.open"), path: {}, query: {}, body: {
            routeId: "route", instanceId: "instance", params: { id: "fixture", initialConfig: {} }, deliveryId: "pending-original-open"
        }
    } as ApiOperationInput;
    const pending = operation.handler(input);
    await started.promise;
    let disposed = false;
    const disposing = owner.dispose().then(() => {
        disposed = true;
    });
    assert.equal(nativeSignal?.aborted, true);
    await Promise.resolve();
    assert.equal(disposed, false);
    responseGate.resolve();
    await cancelStarted.promise;
    assert.equal(disposed, false);
    cancelGate.resolve();
    await disposing;
    assert.equal((await pending).status, 202);
    assert.equal(disposed, true);
    const before = calls;
    assert.equal((await operation.handler({ ...input, body: { ...input.body as object, deliveryId: "new-after-retirement" } })).status, 409);
    assert.equal(calls, before);
});
test("retirement joins an active pump's asynchronous cleanup before returning", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-reactive-pump-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    let releaseCleanup!: () => void, cleanupStarted!: () => void;
    const cleanup = new Promise<void>(done => releaseCleanup = done), started = new Promise<void>(done => cleanupStarted = done);
    const route = {
        id: "route", enabled: true, messageAdapters: ["napcat"], napcatInstances: [{
                id: "instance", enabled: true, botUserId: "12345"
            }]
    } as GatewayDefinition;
    const context: NapcatWebuiManagementContext = {
        protectedResourceObjects: createProtectedResourceObjects(new ResourceCache(root), createAsyncLocalSecretProtector(root), "napcat-webui"), rootDir: root, readOnly: () => false, local: () => true, route: () => route, openManagementSession: async (binding) => ({
            assertCurrent: binding.assertCurrent, runBindingOperation: async (run) => run(), requestManagement: async (_method, native) => {
                if (native.endsWith("CheckLoginStatus"))
                    return Response.json({ code: 0, data: { isLogin: true } });
                if (native.endsWith("GetQQLoginInfo"))
                    return Response.json({ code: 0, data: { uin: "12345" } });
                return new Response(new ReadableStream<Uint8Array>({ start(controller) {
                        controller.enqueue(Buffer.from('event: connected\ndata: {"sessionId":"PRIVATE_SESSION"}\n\n'));
                    }, async cancel() {
                        cleanupStarted();
                        await cleanup;
                    } }), { headers: { "content-type": "text/event-stream" } });
            }
        })
    };
    const owner = createNapcatWebuiReactiveOwner(context), operation = owner.operations.find(item => item.contract.operationId.endsWith("events.open"))!;
    assert.equal((await operation.handler({
        request: { headers: {} } as IncomingMessage, url: new URL("http://localhost/api/agent/qq/webui-management/plugin.config.events.open"), path: {}, query: {}, body: {
            routeId: "route", instanceId: "instance", params: { id: "fixture", initialConfig: {} }, deliveryId: "active-original-open"
        }
    } as ApiOperationInput)).status, 200);
    let disposed = false;
    const disposing = owner.dispose().then(() => {
        disposed = true;
    });
    await started;
    assert.equal(disposed, false);
    releaseCleanup();
    await disposing;
    assert.equal(disposed, true);
});
