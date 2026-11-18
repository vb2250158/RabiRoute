import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import type { ApiOperationInput } from "@rabiroute/host-api/manager/apiOperationContract";
import type { GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import { createNapcatApiDescriptors, type NapcatApiManifest } from "../manager/napcatApiCatalog.js";
import { createNapcatApiOperations } from "../manager/napcatApiOperations.js";
import { napcatCacheMaintenanceActions } from "./cacheMaintenance.js";

/** Fixed dummy value for injected offline test transports; never a real account credential. */
const fixtureAccessToken = "fixture-token";

const manifest = JSON.parse(await fs.readFile(new URL("../../contracts/napcat-4.18.4.json", import.meta.url), "utf8")) as NapcatApiManifest;
const route = { id: "fixture", enabled: true, messageAdapters: ["napcat"], napcatInstances: [
        { id: "instance", enabled: true, httpUrl: "http://127.0.0.1:12345", accessToken: fixtureAccessToken, botUserId: "12345" }
    ] } as GatewayDefinition;
function input(action: string, params: unknown = {}): ApiOperationInput {
    return { request: { headers: {} } as IncomingMessage, response: {}, url: new URL("http://fixture.invalid"), path: {}, query: {},
        body: { routeId: route.id, instanceId: "instance", deliveryId: `cache-${action}`, params } } as ApiOperationInput;
}
for (const action of napcatCacheMaintenanceActions) {
    test(`${action} invokes only its fixed native cache action and reuses the original durable acknowledgement`, async (t) => {
        const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "napcat-native-cache-"));
        t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
        const calls: string[] = [];
        const descriptor = createNapcatApiDescriptors(manifest).find(row => row.action === action)!;
        assert.equal(descriptor.mode, "mutation");
        assert.equal(descriptor.unavailableReason, undefined);
        assert.match(descriptor.description, /without claiming complete cleanup/);
        const [operation] = createNapcatApiOperations({ rootDir, route: () => route, local: () => true, readOnly: () => false,
            transport: async (url) => {
                const name = new URL(String(url)).pathname.slice(1);
                calls.push(name);
                return Response.json({ status: "ok", retcode: 0, data: name === "get_login_info" ? { user_id: 12345 } : null });
            } }, [descriptor]);
        assert.equal((await operation!.handler(input(action, { path: "/caller-path" }))).status, 400);
        assert.deepEqual(calls, []);
        const first = await operation!.handler(input(action)), second = await operation!.handler(input(action));
        assert.equal(first.status, 200);
        assert.equal(second.status, 200);
        assert.deepEqual((first.body as {
            data: unknown;
        }).data, null);
        assert.equal((second.body as {
            delivery: {
                duplicate: boolean;
            };
        }).delivery.duplicate, true);
        assert.equal(calls.filter(value => value === action).length, 1);
        assert.ok(calls.every(value => value === action || value === "get_login_info"));
    });
}
test("a failed native cache response retains uncertainty and never repeats the original cache action", async (t) => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "napcat-native-cache-unknown-"));
    t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
    let effects = 0, readOnly = true;
    const action = "clean_cache", descriptor = createNapcatApiDescriptors(manifest).find(row => row.action === action)!;
    const [operation] = createNapcatApiOperations({ rootDir, route: () => route, local: () => true, readOnly: () => readOnly,
        transport: async (url) => {
            if (new URL(String(url)).pathname === "/get_login_info")
                return Response.json({ status: "ok", retcode: 0, data: { user_id: 12345 } });
            effects++;
            throw new Error("fixture native response lost with private path");
        } }, [descriptor]);
    assert.equal((await operation!.handler(input(action))).status, 403);
    assert.equal(effects, 0);
    readOnly = false;
    for (let attempt = 0; attempt < 2; attempt++) {
        const result = await operation!.handler(input(action));
        assert.equal(result.status, 202);
        assert.doesNotMatch(JSON.stringify(result.body), /private path/);
    }
    assert.equal(effects, 1);
});
