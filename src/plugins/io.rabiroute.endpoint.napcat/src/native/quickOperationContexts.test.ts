// Inert test credential for the isolated native fixture; never used with a real service.
const fixtureAuthToken = "test-only-unusable-auth-value";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { ResourceCache } from "../../../../manager/resourceCache.js";
import { createProtectedResourceObjects } from "../../../../manager/protectedResourceObjects.js";
import { createAsyncLocalSecretProtector } from "../../../../shared/localSecretProtection.js";
import { captureNapcatQuickRequestContext, readNapcatQuickRequestContext } from "./quickOperationContexts.js";
import { WebSocket } from "ws";
import { ManagerPluginRouteRegistry } from "../../../../manager/managerPluginRouteRegistry.js";
import { createNapCatAdapter } from "../adapters/napcatAdapter.js";
test("only original request ingress creates sealed refs which survive restart and reject cross-source or public-cache forgery", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quick-context-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const cache = new ResourceCache(root), objects = createProtectedResourceObjects(cache, createAsyncLocalSecretProtector(root), "message-endpoint-private-metadata@1");
    const source = { routeId: "route", instanceId: "instance", botUserId: "12345", httpUrl: "http://localhost:12345", accessToken: fixtureAuthToken };
    const signal = new AbortController().signal, event = { post_type: "request", request_type: "group", sub_type: "invite", self_id: 12345, user_id: 456, group_id: 789, flag: "PRIVATE_ORIGINAL_FLAG", comment: "PRIVATE_NOT_STORED" };
    const id = await captureNapcatQuickRequestContext(objects, source, event, () => {
    }, signal);
    assert.match(id!, /^[a-f0-9]{64}$/);
    const rebuilt = createProtectedResourceObjects(new ResourceCache(root), createAsyncLocalSecretProtector(root), "message-endpoint-private-metadata@1");
    const read = await readNapcatQuickRequestContext(rebuilt, source, id!, () => {
    }, signal);
    assert.equal(read.flag, event.flag);
    assert.equal(read.sub_type, "invite");
    assert(!("comment" in read));
    for (const change of [{ routeId: "other" }, { instanceId: "other" }, { botUserId: "23456" }, { httpUrl: "http://localhost:23456" }, { accessToken: "changed" }]) {
        await assert.rejects(readNapcatQuickRequestContext(rebuilt, { ...source, ...change }, id!, () => {
        }, signal));
    }
    const owner = "napcat.quick-request." + createHash("sha256").update(JSON.stringify([source.routeId, source.instanceId, source.botUserId, new URL(source.httpUrl).href, source.accessToken])).digest("hex");
    for (const row of await cache.findByOwner(owner)) {
        const raw = await cache.read(owner, row.id);
        assert(!raw.includes(Buffer.from(event.flag)));
        assert(!raw.includes(Buffer.from(event.comment)));
    }
    const forged = Buffer.from(JSON.stringify({ kind: "napcat-quick-request/v1", request: event })), forgedId = createHash("sha256").update(forged).digest("hex");
    await cache.put(owner, forgedId, forged);
    await assert.rejects(readNapcatQuickRequestContext(objects, source, forgedId, () => {
    }, signal));
    let puts = 0;
    const counting = { ...objects, putProtected: async (...args: Parameters<typeof objects.putProtected>) => {
            puts++;
            return objects.putProtected(...args);
        } };
    assert.equal(await captureNapcatQuickRequestContext(counting, source, { post_type: "message", self_id: 12345 }, () => {
    }, signal), undefined);
    assert.equal(await captureNapcatQuickRequestContext(counting, source, { ...event, self_id: 23456 }, () => {
    }, signal), undefined);
    assert.equal(puts, 0);
});
test("capture cancellation and owner retirement fence pending publication", async () => {
    const source = { routeId: "route", instanceId: "instance", botUserId: "12345", httpUrl: "http://localhost:12345", accessToken: "" }, controller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>(done => release = done);
    let active = true, published = 0;
    const pending = captureNapcatQuickRequestContext({ readProtected: async () => Buffer.alloc(0), putProtected: async (_owner, _bytes, authorize) => {
            await gate;
            authorize();
            published++;
            return { id: "a".repeat(64) };
        } }, source, { post_type: "request", request_type: "friend", self_id: 12345, user_id: 456, flag: "original" }, () => {
        if (!active)
            throw Error("retired");
    }, controller.signal);
    active = false;
    controller.abort();
    release();
    await assert.rejects(pending);
    assert.equal(published, 0);
});
test("actual WS ingress awaits capture, publishes only the safe ref and preserves handling when ref issuance fails", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quick-ingress-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const objects = createProtectedResourceObjects(new ResourceCache(root), createAsyncLocalSecretProtector(root), "message-endpoint-private-metadata@1");
    const registry = new ManagerPluginRouteRegistry();
    let captures = 0, handled = 0, ref: string | undefined;
    let notify!: () => void;
    const completed = () => new Promise<void>(done => notify = done);
    const saved = { id: "instance", name: "fixture", enabled: true, autoLoginOnRabiStart: false, gatewayPort: 0, httpUrl: "http://localhost:12345", webuiUrl: "http://localhost:12346", accessToken: fixtureAuthToken };
    const adapter = createNapCatAdapter({ routeId: "route", eventBotUserId: () => "12345", instances: () => [saved], dataDir: () => root, apiOperations: registry, refreshProfile() {
        },
        captureQuickRequestContext: async (event, instance, frame, authorize) => {
            captures++;
            if (captures === 2)
                throw Error("PRIVATE_ORIGINAL_FLAG");
            ref = await captureNapcatQuickRequestContext(objects, { routeId: "route", instanceId: instance.id, botUserId: "12345", httpUrl: instance.httpUrl, accessToken: instance.accessToken ?? "" }, event, authorize, frame.signal);
            return ref;
        }, async handleEvent() {
            handled++;
            notify();
        }
    });
    const dispose = await adapter.start();
    t.after(() => dispose?.());
    const port = registry.catalogSnapshot().listeners[0]!.binding.address.port;
    const socket = await new Promise<WebSocket>((resolve, reject) => {
        const value = new WebSocket(`ws://127.0.0.1:${port}`);
        value.once("open", () => resolve(value));
        value.once("error", reject);
    });
    const event = { post_type: "request", request_type: "friend", self_id: 12345, user_id: 456, flag: "PRIVATE_ORIGINAL_FLAG", comment: "PRIVATE_REQUEST_BODY" };
    let done = completed();
    socket.send(JSON.stringify(event));
    await done;
    assert.match(ref!, /^[a-f0-9]{64}$/);
    assert.equal(handled, 1);
    done = completed();
    socket.send(JSON.stringify(event));
    await done;
    assert.equal(handled, 2);
    const logs: string[] = [];
    const walk = (directory: string) => {
        for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
            const p = path.join(directory, item.name);
            if (item.isDirectory())
                walk(p);
            else if (item.name.endsWith(".jsonl"))
                logs.push(fs.readFileSync(p, "utf8"));
        }
    };
    walk(root);
    assert(logs.some(log => log.includes(ref!)));
    assert(!logs.some(log => log.includes(event.flag) || log.includes(event.comment)));
    await dispose?.();
    socket.terminate();
});
test("actual gateway entry binds empty profile config to trusted route identity and original transport-input QQ", async () => {
    const source = fs.readFileSync(new URL("../../gateway.mjs", import.meta.url), "utf8");
    const activationCode = source.replace(/^import .*;\r?$/gm, "").replace("export const activate", "const activate");
    let dependencies: Record<string, unknown> | undefined, capturedSource: Record<string, unknown> | undefined;
    const protectedObjects = { original: true };
    const host = { prepareModules: async () => {
        }, protectedResourceObjects: protectedObjects };
    const originalEgress = { readReplySource() {
        }, getLoginInfo() {
        }, sendGroupMessage() {
        }, sendPrivateMessage() {
        }, uploadGroupFile() {
        }, uploadPrivateFile() {
        }, readNapCatGroupFiles() {
        }, napcatStickerMessage() {
        }, captureNapcatQuickRequestContext: async (objects: unknown, identity: Record<string, unknown>) => {
            assert.equal(objects, protectedObjects);
            capturedSource = identity;
            return "a".repeat(64);
        } };
    const factory = new Function("createEgress", "egressModules", "definePlugin", "ownMessageEndpointEgress", "ownMessageEndpoint", "createImplementation", "hostModules", "projectRouteTransport", activationCode + "\nreturn activate;");
    const activate = factory(() => originalEgress, [], (definition: unknown) => definition, (_context: unknown, egress: {
        operations: Record<string, unknown>;
    }) => {
        assert.equal(Object.keys(egress.operations).length, 8);
        assert(!("captureNapcatQuickRequestContext" in egress.operations));
    }, () => {
    }, () => ({ create: (input: Record<string, unknown>) => {
            dependencies = input;
            return { type: "napcat" };
        } }), [], () => ({ napcatInstances: [] }));
    const config = { __routeTransportInputs: { napcatInstances: [{ id: "instance", botUserId: "12345" }] } };
    await activate({ identity: { managerInstanceId: "actual-route" }, config, services: { require: (service: string) => {
                assert.equal(service, "host.message-endpoints@4");
                return { prepareModules: async () => {
                    }, module: () => ({ config: {} }), forActivation: () => host };
            }, provide() {
            } } });
    assert.equal(dependencies!.routeId, "actual-route");
    const configured = dependencies!.eventBotUserId as (id: string) => unknown;
    assert.equal(configured("instance"), "12345");
    assert.equal(configured("unconfigured"), undefined);
    const capture = dependencies!.captureQuickRequestContext as (...args: unknown[]) => Promise<string>;
    assert.equal(await capture({ post_type: "request" }, { id: "instance", httpUrl: "http://localhost:12345", accessToken: fixtureAuthToken }, { signal: new AbortController().signal }, () => {
    }), "a".repeat(64));
    assert.equal(capturedSource!.routeId, "actual-route");
    assert.equal(capturedSource!.botUserId, "12345");
    assert.equal((config as Record<string, unknown>).id, undefined);
    assert.equal((config as Record<string, unknown>).napcatInstances, undefined);
});
