import { createProtectedResourceObjects } from "../../../../manager/protectedResourceObjects.js";
import { createAsyncLocalSecretProtector } from "../../../../shared/localSecretProtection.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import type { GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import type { ApiOperationInput } from "@rabiroute/host-api/manager/apiOperationContract";
import { createNapcatWebuiExtendedOperations } from "./napcatWebuiExtendedOperations.js";
import { napcatWebuiExtendedDescriptors, assertNapcatWebuiExtendedRequest } from "./napcatWebuiExtendedContracts.js";
import { ResourceCache } from "../../../../manager/resourceCache.js";
import { RESOURCE_OBJECT_MAX_BYTES } from "../../../../manager/resourceCacheProtocol.js";
import type { NapcatWebuiManagementContext } from "./napcatWebuiManagementOperations.js";
// Synthetic non-credential values belong only to this isolated native fixture.
const fixturePassword = "PRIVATE_FIXTURE";
const fixturePemLabel = ["PRIVATE", "KEY"].join(" ");
const fixtureSslKey = [`-----BEGIN ${fixturePemLabel}-----`, "deliberately invalid test key"].join("\n");
const fixtureSslCertificate = ["-----BEGIN " + "CERTIFICATE-----", "deliberately invalid test certificate", "-----END " + "CERTIFICATE-----"].join("\n");
type Row = Record<string, unknown>;
function fixture(t: test.TestContext) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-extended-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const state = {
        loggedIn: false, uin: "", platform: "linux", readOnly: false, fail: false, config: { fileLog: false, packetServer: "PRIVATE_FIXTURE" } as Row, webui: { port: 6099 } as Row
    };
    const calls: Array<{
        path: string;
        body: Row;
        method: string;
    }> = [];
    const definition = {
        id: "route", enabled: true, messageAdapters: ["napcat"], napcatInstances: [{
                id: "instance", enabled: true, botUserId: "12345"
            }]
    } as GatewayDefinition;
    const context: NapcatWebuiManagementContext = {
        protectedResourceObjects: createProtectedResourceObjects(new ResourceCache(root), createAsyncLocalSecretProtector(root), "napcat-webui"), rootDir: root, readOnly: () => state.readOnly, local: () => true, route: () => definition,
        resourceObjects: (() => {
            const store = new ResourceCache(root);
            return {
                maxObjectBytes: RESOURCE_OBJECT_MAX_BYTES, put: (owner: string, id: string, bytes: Uint8Array, authorize: () => void) => store.put(owner, id, Buffer.from(bytes), authorize), read: (owner: string, id: string) => store.read(owner, id), findByOwner: (owner: string) => store.findByOwner(owner)
            };
        })(),
        transport: async () => {
            throw new Error("No OneBot bootstrap");
        }, openManagementSession: async (binding) => ({
            assertCurrent: binding.assertCurrent, runBindingOperation: async (run) => run(), requestManagement: async (method, nativePath, body) => {
                calls.push({
                    path: nativePath, body, method
                });
                let data: unknown = null;
                if (nativePath.endsWith("/CheckLoginStatus"))
                    data = { isLogin: state.loggedIn };
                else if (nativePath.endsWith("/GetQQLoginInfo"))
                    data = { uin: state.uin };
                else if (nativePath.endsWith("/GetPlatformInfo"))
                    data = { platform: state.platform };
                else if (nativePath === "/api/NapCatConfig/GetConfig" || nativePath === "/api/NapCatConfig/GetUinConfig")
                    data = state.config;
                else if (nativePath === "/api/NapCatConfig/SetConfig" || nativePath === "/api/NapCatConfig/SetUinConfig") {
                    state.config = { ...state.config, ...body };
                    if (state.fail)
                        throw new Error("After execution connection lost");
                }
                else if (nativePath === "/api/WebUIConfig/UpdateConfig")
                    state.webui = { ...state.webui, ...body };
                else if (nativePath === "/api/WebUIConfig/GetConfig")
                    data = state.webui;
                else if (nativePath === "/api/WebUIConfig/UpdateDisableWebUI")
                    state.webui.disableWebUI = body.disable;
                else if (nativePath === "/api/WebUIConfig/GetDisableWebUI")
                    data = state.webui.disableWebUI;
                else if (nativePath === "/api/Mirror/List")
                    data = { fileMirrors: ["https://PRIVATE_FIXTURE/private?token=x"], rawMirrors: [""] };
                else if (nativePath === "/api/Mirror/Test")
                    data = {
                        success: true, latency: 5, mirror: "PRIVATE_FIXTURE", error: ""
                    };
                else if (nativePath === "/api/Mirror/Test/SSE")
                    return new Response('data: {"type":"result","index":0,"result":{"success":true,"latency":5,"mirror":"PRIVATE_FIXTURE"}}\n\ndata: {"type":"complete","failed":[]}\n\n', { headers: { "content-type": "text/event-stream" } });
                else if (nativePath === "/api/Plugin/Store/Install/SSE")
                    return new Response('data: {"success":true,"installPath":"PRIVATE_FIXTURE"}\n\n', { headers: { "content-type": "text/event-stream" } });
                else if (nativePath === "/api/Plugin/List")
                    data = { plugins: [{
                                id: "fixture", status: "active", version: "1.0.0"
                            }] };
                else if (nativePath === "/api/UpdateNapCat/update")
                    data = {
                        status: "completed", newVersion: "v4.18.4", failedFilesCount: 2, message: "PRIVATE_PATH"
                    };
                else if (nativePath === "/api/auth/check")
                    data = { authenticated: true };
                else if (nativePath === "/api/base/getLatestTag")
                    data = "v4.18.4";
                else if (nativePath === "/api/base/getAllReleases")
                    data = {
                        versions: [{ tag: "v4.18.4", type: "release" }], pagination: {
                            page: 1, pageSize: 20, total: 1, totalPages: 1
                        }, mirror: "https://PRIVATE_FIXTURE/path?key=PRIVATE_FIXTURE"
                    };
                else if (method === "GET" && nativePath === "/api/Plugin/Config")
                    data = {
                        schema: [{ key: "password" }], config: { password: fixturePassword }, supportReactive: true
                    };
                else
                    data = { message: "PRIVATE_FIXTURE", path: "C:/PRIVATE_FIXTURE" };
                return Response.json({ code: 0, data });
            }
        })
    };
    const operations = createNapcatWebuiExtendedOperations(context);
    const run = (id: string, params: Row = {}, deliveryId?: string) => operations.find(x => x.contract.operationId === `agent.qq.webui.management.${id}`)!.handler({
        request: { headers: {} } as IncomingMessage, url: new URL(`http://localhost/api/agent/qq/webui-management/${id}`), path: {}, query: {}, body: {
            routeId: "route", instanceId: "instance", params, ...(deliveryId ? { deliveryId } : {})
        }
    } as ApiOperationInput);
    return {
        root, state, calls, run, operations
    };
}
test("fixed extended owners preserve native schemas and acknowledge separately from persistence", async (t) => {
    const f = fixture(t);
    assert.equal(f.operations.length, 29);
    assert.equal(napcatWebuiExtendedDescriptors.length, 29);
    for (const spec of napcatWebuiExtendedDescriptors) {
        const p = spec.id === "native.release.update" ? {
            targetVersion: "v4.18.4", force: false, mirrorIndex: 0
        } : spec.id.startsWith("plugin.store.install") ? { id: "fixture" } : spec.id === "mirror.test" ? { type: "file", mirrorIndex: 0 } : spec.id === "mirror.tests" ? { type: "raw" } : spec.id === "ssl.install" ? { cert: fixtureSslCertificate, key: fixtureSslKey } : spec.id.endsWith("restore") ? { backupName: spec.platform === "linux" ? "machine-info.bak.123" : "Registry20.bak.123" } : spec.id.endsWith("guid.set") ? { guid: "a".repeat(32) } : spec.id.endsWith("mac.set") ? { mac: "11-22-33-44-55-66" } : spec.id === "plugin.status.set" ? { id: "fixture", enable: true } : spec.id === "plugin.uninstall" ? { id: "fixture", cleanData: false } : spec.id === "plugin.config.set" ? { id: "fixture", config: { password: fixturePassword } } : spec.id === "plugin.config.summary" ? { id: "fixture" } : spec.id === "webui-disabled.set" ? { disable: true } : spec.id === "native-config.set" || spec.id === "account-config.set" ? { fileLog: true } : spec.id === "webui-config.set" ? { port: 6099 } : {};
        f.state.platform = spec.platform ?? "linux";
        f.state.loggedIn = spec.binding === "login-required";
        f.state.uin = f.state.loggedIn ? "12345" : "";
        const result = await f.run(spec.id, p, spec.effects === "configuration-mutation" ? "id-" + spec.id : undefined);
        assert.equal(result.status, 200, spec.id + JSON.stringify(result.body));
        assert(!JSON.stringify(result.body).includes("PRIVATE_FIXTURE"), spec.id);
    }
});
test("mutation receipt binds digest, preserves merged config and never replays uncertain execution", async (t) => {
    const f = fixture(t);
    f.state.fail = true;
    const first = await f.run("native-config.set", { fileLog: true }, "uncertain");
    assert.equal(first.status, 202);
    const count = f.calls.filter(x => x.path === "/api/NapCatConfig/SetConfig").length;
    assert.equal((await f.run("native-config.set", { fileLog: true }, "uncertain")).status, 202);
    assert.equal(f.calls.filter(x => x.path === "/api/NapCatConfig/SetConfig").length, count);
    assert.equal((await f.run("native-config.set", { fileLog: false }, "uncertain")).status, 409);
    const ledger = fs.readdirSync(f.root, { recursive: true }).filter(x => String(x).endsWith(".json"));
    for (const rel of ledger)
        assert(!fs.readFileSync(path.join(f.root, String(rel)), "utf8").includes("PRIVATE_FIXTURE"));
});
test("read-only, mismatched OS, active login, secret fields and path traversal reject before native mutation", async (t) => {
    const f = fixture(t);
    f.state.readOnly = true;
    assert.equal((await f.run("ssl.delete", {}, "ro")).status, 403);
    assert.equal(f.calls.length, 0);
    f.state.readOnly = false;
    assert.equal((await f.run("device.windows.reset", {}, "platform")).status, 409);
    f.state.loggedIn = true;
    f.state.uin = "12345";
    assert.equal((await f.run("device.linux.reset", {}, "active")).status, 409);
    assert.equal((await f.run("webui-config.set", { token: "PRIVATE_FIXTURE" }, "token")).status, 400);
    assert.equal((await f.run("device.windows.restore", { backupName: "Registry20.bak.../outside" }, "escape")).status, 400);
    assert.equal(assertNapcatWebuiExtendedRequest("GET", "/api/not-registered", {}), false);
    assert.throws(() => assertNapcatWebuiExtendedRequest("GET", "/api/base/getAllReleases", { mirror: "https://untrusted.example" }));
});
