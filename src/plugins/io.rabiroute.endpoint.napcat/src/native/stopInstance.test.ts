import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import type { ApiOperationInput } from "@rabiroute/host-api/manager/apiOperationContract";
import type { GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import { createNapcatStopOperation } from "./stopInstance.js";
function input(): ApiOperationInput {
    return { request: { headers: {} } as IncomingMessage, response: {}, path: {}, query: {}, url: new URL("http://fixture.invalid"),
        body: { routeId: "route", instanceId: "instance", deliveryId: "original-stop", params: {} } } as ApiOperationInput;
}
async function fixture(context: test.TestContext, uncertain = false) {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "napcat-stop-owner-"));
    context.after(() => fs.rm(rootDir, { recursive: true, force: true }));
    const route = { id: "route", enabled: true, messageAdapters: ["napcat"], napcatInstances: [
            { id: "instance", enabled: true, httpUrl: "http://127.0.0.1:12345", botUserId: "12345" }
        ] } as GatewayDefinition;
    let stops = 0;
    let probes = 0;
    const operation = createNapcatStopOperation({ rootDir, route: () => route, local: () => true, readOnly: () => false,
        transport: async (url) => {
            assert.equal(new URL(String(url)).pathname, "/get_login_info");
            probes++;
            return Response.json({ status: "ok", retcode: 0, data: { user_id: 12345 } });
        }, stopOwnedNapcat: async (request, authorize) => {
            authorize();
            assert.deepEqual(request, { gatewayId: "route", instanceId: "instance" });
            stops++;
            if (uncertain)
                throw Error("original owner response lost");
            return { ok: true };
        } });
    return { operation, route, counts: () => ({ stops, probes }) };
}
test("bot_exit compatibility drains the original instance owner once and keeps account configuration", async (context) => {
    const value = await fixture(context);
    assert.equal((await value.operation.handler(input())).status, 200);
    assert.equal((await value.operation.handler(input())).status, 200);
    assert.deepEqual(value.counts(), { stops: 1, probes: 1 });
    assert.equal(value.route.enabled, true);
    assert.equal(value.route.napcatInstances![0].botUserId, "12345");
});
test("an uncertain native lifecycle stop never repeats or invents an acknowledgement", async (context) => {
    const value = await fixture(context, true);
    assert.equal((await value.operation.handler(input())).status, 202);
    assert.equal((await value.operation.handler(input())).status, 202);
    assert.deepEqual(value.counts(), { stops: 1, probes: 1 });
});
