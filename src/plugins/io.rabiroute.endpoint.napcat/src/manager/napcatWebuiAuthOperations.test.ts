import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import type { GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import type { ApiOperationInput } from "@rabiroute/host-api/manager/apiOperationContract";
import { ResourceCache } from "../../../../manager/resourceCache.js";
import { RESOURCE_OBJECT_MAX_BYTES } from "../../../../manager/resourceCacheProtocol.js";
import { createNapcatWebuiAuthOperations } from "./napcatWebuiAuthOperations.js";
import { prepareNapcatWebuiTokenCommit } from "./napcatWebuiTokenCommit.js";
import { readDurableDeliveryReceipt } from "@rabiroute/host-api/manager/durableDeliveryIdempotency";
import { putNapcatWebuiObject, readNapcatWebuiObject } from "./napcatWebuiResources.js";
import type { NapcatWebuiManagementContext } from "./napcatWebuiManagementOperations.js";
test("native passkey workflows protect challenge/assertions and token rotation requires the original persisted source owner", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-auth-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = new ResourceCache(root), calls: string[] = [], commits: string[] = [];
    const route = {
        id: "route", enabled: true, messageAdapters: ["napcat"], napcatInstances: [{
                id: "instance", enabled: true, botUserId: "12345"
            }]
    } as GatewayDefinition;
    const context: NapcatWebuiManagementContext = {
        rootDir: root, readOnly: () => false, local: () => true, route: () => route, resourceObjects: {
            maxObjectBytes: RESOURCE_OBJECT_MAX_BYTES, put: (owner, id, bytes, authorize) => store.put(owner, id, Buffer.from(bytes), authorize), read: (owner, id) => store.read(owner, id), findByOwner: owner => store.findByOwner(owner)
        }, openManagementSession: async (binding) => ({
            assertCurrent: binding.assertCurrent, runBindingOperation: async (run) => run(), runTokenRotation: async (run) => run(), requestManagement: async (_method, native, body) => {
                calls.push(native);
                let data: unknown;
                if (native.endsWith("CheckLoginStatus"))
                    data = { isLogin: true };
                else if (native.endsWith("GetQQLoginInfo"))
                    data = { uin: "12345" };
                else if (native.includes("generate-"))
                    data = {
                        challenge: "bm9uY2U", rp: { id: "native.example" }, Credential: "PRIVATE_UNEXPECTED"
                    };
                else if (native.endsWith("verify-authentication")) {
                    assert((body.response as Record<string, unknown>).id === "assertion");
                    data = { authenticated: true };
                }
                else if (native.endsWith("verify-registration"))
                    data = { verified: true };
                else if (native.endsWith("update_token")) {
                    assert.equal(body.newToken, "PRIVATE_NEW_TOKEN_123");
                    data = { changed: true };
                }
                else
                    throw new Error("unexpected fixed path");
                return Response.json({ code: 0, data });
            }
        })
    };
    const operations = createNapcatWebuiAuthOperations(context), run = (id: string, params: Record<string, unknown> = {}, deliveryId = "intent-" + id) => operations.find(x => x.contract.operationId === `agent.qq.webui.management.${id}`)!.handler({
        request: { headers: {} } as IncomingMessage, url: new URL(`http://localhost/api/agent/qq/webui-management/${id}`), path: {}, query: {}, body: {
            routeId: "route", instanceId: "instance", params, deliveryId
        }
    } as ApiOperationInput);
    const binding = {
        routeId: "route", instanceId: "instance", expectedUserId: "12345", assertCurrent: () => {
        }
    };
    const assertion = JSON.parse('{"id":"assertion","rawId":"YQ","type":"public-key","response":{"clientDataJSON":"YQ","signature":"YQ","authenticatorData":"YQ"}}');
    for (const id of [
        "passkey.authentication.options", "passkey.registration.options", "passkey.authentication.verify", "passkey.registration.verify"
    ]) {
        const result = await run(id, id.endsWith("verify") ? { response: assertion } : {});
        assert.equal(result.status, 200);
        assert(!JSON.stringify(result.body).includes("PRIVATE_"));
        if (id.endsWith("options")) {
            const data = (result.body as {
                data: {
                    publicKey: {
                        challenge: string;
                    };
                };
            }).data;
            assert.equal(data.publicKey.challenge, "bm9uY2U");
        }
    }
    const newToken = "PRIVATE_NEW_TOKEN_123";
    const before = calls.length;
    assert.equal((await run("session.token.rotate", { newToken })).status, 409);
    assert.equal(calls.length, before);
    context.prepareWebuiToken = async (_binding, operationId) => ({ commit: async (token) => {
            commits.push(token);
            return {
                state: "committed", operationId, revision: "revision", assertCurrent: () => {
                }
            };
        } });
    assert.equal((await run("session.token.rotate", { newToken })).status, 200);
    assert.deepEqual(commits, ["PRIVATE_NEW_TOKEN_123"]);
    assert.equal((await run("session.token.rotate", { newToken })).status, 200);
    assert.equal(commits.length, 1);
});
test("actual durable token settlement adopts only the verified replacement authority and retains pending runtime activation as uncertain", async (t) => {
    for (const activateRuntime of [true, false]) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-token-settlement-"));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        let persisted = {
            id: "route", enabled: true, messageAdapters: ["napcat"], napcatInstances: [{
                    id: "instance", enabled: true, botUserId: "12345", webuiUrl: "http://native.fixture", webuiToken: "ORIGINAL_123"
                }]
        } as GatewayDefinition;
        let runtime = persisted, nativeToken = "ORIGINAL_123", revision = "before", rotations = 0;
        const store = new ResourceCache(root);
        const context: NapcatWebuiManagementContext = {
            rootDir: root, readOnly: () => false, local: () => true, route: () => runtime, resourceObjects: {
                maxObjectBytes: RESOURCE_OBJECT_MAX_BYTES, put: (owner, id, bytes, authorize) => store.put(owner, id, Buffer.from(bytes), authorize), read: (owner, id) => store.read(owner, id), findByOwner: owner => store.findByOwner(owner)
            }, openManagementSession: async (binding) => {
                if (runtime.napcatInstances![0]!.webuiToken !== nativeToken)
                    throw new Error("Old runtime credential cannot authenticate replacement native source");
                return {
                    assertCurrent: binding.assertCurrent, runBindingOperation: async (run) => {
                        binding.assertCurrent();
                        const result = await run();
                        binding.assertCurrent();
                        return result;
                    }, runTokenRotation: async (run) => {
                        binding.assertCurrent();
                        return run();
                    }, requestManagement: async (_method, native, body) => {
                        binding.assertCurrent();
                        if (native.endsWith("CheckLoginStatus"))
                            return Response.json({ code: 0, data: { isLogin: true } });
                        if (native.endsWith("GetQQLoginInfo"))
                            return Response.json({ code: 0, data: { uin: "12345" } });
                        assert.equal(native, "/api/auth/update_token");
                        rotations++;
                        nativeToken = String(body.newToken);
                        return Response.json({ code: 0, data: { changed: true } });
                    }
                };
            }
        };
        context.prepareWebuiToken = (binding, operationId) => prepareNapcatWebuiTokenCommit({
            assertCurrent: () => {
            }, readRoutes: () => [structuredClone(persisted)], routeVersion: () => revision, writeRoute: async (_id, value, expected, _operationId) => {
                assert.equal(expected, "before");
                persisted = structuredClone(value);
                revision = "after";
            }, resolveRouteMutation: async () => ({ state: "committed" }), syncRoutes: () => {
                if (activateRuntime)
                    runtime = structuredClone(persisted);
            }, inspectSource: async (_binding, token) => ({
                credentialSource: "provided", explicitTokenSource: "instance", nativeConfigMatches: token === nativeToken, configuredValueMatches: token === runtime.napcatInstances![0]!.webuiToken
            })
        }, binding, operationId);
        const binding = {
            routeId: "route", instanceId: "instance", expectedUserId: "12345", assertCurrent: () => {
            }
        };
        const operation = createNapcatWebuiAuthOperations(context).find(op => op.contract.operationId.endsWith("session.token.rotate"))!;
        const input = {
            request: { headers: {} } as IncomingMessage, url: new URL("http://localhost/api/agent/qq/webui-management/session.token.rotate"), path: {}, query: {}, body: {
                routeId: "route", instanceId: "instance", params: { newToken: "REPLACEMENT_456" }, deliveryId: "original-token-intent"
            }
        } as ApiOperationInput;
        const result = await operation.handler(input);
        assert.equal(result.status, activateRuntime ? 200 : 202);
        assert.equal(rotations, 1);
        assert.equal(persisted.napcatInstances![0]!.webuiToken, "REPLACEMENT_456");
        const receipt = readDurableDeliveryReceipt(root, "napcat-webui-management-v1", "original-token-intent");
        assert.equal(receipt?.state, activateRuntime ? "completed" : "uncertain");
        assert(!JSON.stringify(receipt).includes("REPLACEMENT_456"));
        if (activateRuntime) {
            assert.equal((await operation.handler(input)).status, 200);
            assert.equal(rotations, 1);
        }
    }
});
