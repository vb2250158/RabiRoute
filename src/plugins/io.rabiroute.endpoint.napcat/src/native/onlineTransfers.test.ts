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
import { napcatOnlineTransferActions } from "./onlineTransfers.js";

/** Fixed dummy value for injected offline test transports; never a real account credential. */
const fixtureAccessToken = "fixture-token";

const manifest = JSON.parse(await fs.readFile(new URL("../../contracts/napcat-4.18.4.json", import.meta.url), "utf8")) as NapcatApiManifest;
const route = { id: "fixture", enabled: true, messageAdapters: ["napcat"], napcatInstances: [
        { id: "instance", enabled: true, httpUrl: "http://127.0.0.1:12345", accessToken: fixtureAccessToken, botUserId: "12345" }
    ] } as GatewayDefinition;
for (const action of napcatOnlineTransferActions) {
    test(`${action} retains native transfer IDs and exposes an acknowledgement without native paths or raw results`, async (t) => {
        const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "napcat-native-transfer-"));
        t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
        const params = { user_id: "45678", msg_id: "native-message-id", ...(action === "cancel_online_file" ? {} : { element_id: "original-element-id" }) };
        const calls: Array<{
            action: string;
            params: unknown;
        }> = [];
        const descriptor = createNapcatApiDescriptors(manifest).find(row => row.action === action)!;
        assert.equal(descriptor.mode, "mutation");
        assert.equal(descriptor.unavailableReason, undefined);
        assert.match(descriptor.description, /does not certify completed file transfer/);
        const [operation] = createNapcatApiOperations({ rootDir, route: () => route, local: () => true, readOnly: () => false,
            transport: async (url, options) => {
                const name = new URL(String(url)).pathname.slice(1);
                calls.push({ action: name, params: JSON.parse(String(options?.body)) });
                return Response.json({ status: "ok", retcode: 0, data: name === "get_login_info" ? { user_id: 12345 }
                        : { acknowledged: true, path: "/native/private", token: "not-public" } });
            } }, [descriptor]);
        const input = { request: { headers: {} } as IncomingMessage, response: {}, url: new URL("http://fixture.invalid"), path: {}, query: {},
            body: { routeId: route.id, instanceId: "instance", deliveryId: `transfer-${action}`, params } } as ApiOperationInput;
        assert.equal((await operation!.handler({ ...input, body: { ...input.body as object, params: { ...params, destination: "/caller/path" } } })).status, 400);
        assert.equal(calls.length, 0);
        for (let attempt = 0; attempt < 2; attempt++) {
            const result = await operation!.handler(input);
            assert.equal(result.status, 200);
            assert.equal((result.body as {
                data: unknown;
            }).data, null);
            assert.doesNotMatch(JSON.stringify(result.body), /native\/private|not-public/);
        }
        assert.deepEqual(calls.filter(row => row.action !== "get_login_info"), [{ action, params }]);
    });
}
