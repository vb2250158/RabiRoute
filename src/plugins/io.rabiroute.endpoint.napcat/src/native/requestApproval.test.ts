import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import type { ApiOperationInput } from "@rabiroute/host-api/manager/apiOperationContract";
import type { GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import { createNapcatApiDescriptors, type NapcatApiManifest } from "../manager/napcatApiCatalog.js";
import { createNapcatApiOperations } from "../manager/napcatApiOperations.js";
import { selectNapcatApiInstance } from "../manager/napcatApiTransport.js";
import { captureNapcatQuickRequestContext, readNapcatQuickRequestContext } from "./quickOperationContexts.js";
import { memoryResourceObjects } from "./artifactObjects.fixture.js";

const manifest = JSON.parse(await fs.readFile(new URL("../../contracts/napcat-4.18.4.json", import.meta.url), "utf8")) as NapcatApiManifest;
for (const requestType of ["friend", "group"] as const) test(`sealed ${requestType} approval uses the same native receipt without persisting its request flag`, async context => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "napcat-sealed-approval-"));
    context.after(() => fs.rm(rootDir, { recursive: true, force: true }));
    const route = { id: "route", enabled: true, messageAdapters: ["napcat"], napcatInstances: [
        { id: "instance", enabled: true, httpUrl: "http://127.0.0.1:12345", botUserId: "12345" }
    ] } as GatewayDefinition;
    const request = { headers: {} } as IncomingMessage;
    const store = memoryResourceObjects();
    const base = { route: () => route, local: () => true };
    const selection = selectNapcatApiInstance(base, request, "route", "instance");
    const eventRef = await captureNapcatQuickRequestContext(store.protectedResources, selection, {
        post_type: "request", request_type: requestType, self_id: "12345", user_id: "456", flag: "private-real-event-flag",
        ...(requestType === "group" ? { group_id: "789", sub_type: "invite" } : {})
    }, selection.assertCurrent, AbortSignal.timeout(2000));
    assert.ok(eventRef);
    const action = requestType === "friend" ? "set_friend_add_request" : "set_group_add_request";
    const calls: Record<string, unknown>[] = [];
    let resolutions = 0;
    const descriptor = createNapcatApiDescriptors(manifest).filter(value => value.action === action);
    const operation = createNapcatApiOperations({ ...base, rootDir, readOnly: () => false,
        resolveQuickRequest: async (source, reference, signal) => {
            resolutions++;
            return readNapcatQuickRequestContext(store.protectedResources, source, reference, source.assertCurrent, signal);
        },
        transport: async (url, init) => {
            const operation = new URL(String(url)).pathname.slice(1);
            if (operation === "get_login_info") return Response.json({ status: "ok", retcode: 0, data: { user_id: "12345" } });
            assert.equal(operation, action); calls.push(JSON.parse(String(init?.body)));
            return Response.json({ status: "ok", retcode: 0, data: null });
        }
    }, descriptor)[0];
    const input = { request, response: {}, path: {}, query: {}, url: new URL("http://fixture.invalid"), body: {
        routeId: "route", instanceId: "instance", deliveryId: "original-sealed-approval", params: {
            eventRef, approve: true, ...(requestType === "group" ? { sub_type: "invite" } : { remark: "approved friend" })
        }
    } } as ApiOperationInput;
    const first = await operation.handler(input);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal((await operation.handler(input)).status, 200);
    assert.equal(calls.length, 1); assert.equal(resolutions, 1);
    assert.equal(calls[0].flag, "private-real-event-flag"); assert.equal(calls[0].eventRef, undefined); assert.equal(calls[0].sub_type, undefined);
    for (const file of await fs.readdir(rootDir, { recursive: true })) {
        if (file.endsWith(".json")) assert.doesNotMatch(await fs.readFile(path.join(rootDir, file), "utf8"), /private-real-event-flag/);
    }
    const forbidden = { ...input, body: { ...input.body as object, nativeParameters: { flag: "caller-forged" } } };
    assert.equal((await operation.handler(forbidden)).status, 400);
    assert.equal(calls.length, 1);
});
