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
const manifest = JSON.parse(await fs.readFile(new URL("../../contracts/napcat-4.18.4.json", import.meta.url), "utf8")) as NapcatApiManifest;
const route = { id: "route", enabled: true, messageAdapters: ["napcat"], napcatInstances: [
        { id: "instance", enabled: true, httpUrl: "http://127.0.0.1:12345", botUserId: "12345" }
    ] } as GatewayDefinition;
function input(): ApiOperationInput {
    return { request: { headers: {} } as IncomingMessage, response: {}, path: {}, query: {}, url: new URL("http://fixture.invalid"),
        body: { routeId: "route", instanceId: "instance", deliveryId: "original-button", params: {
                source: { kind: "group", targetId: "789", messageId: "12" }, bot_appid: "application", button_id: "button",
                callback_data: "private-callback", msg_seq: "35"
            } } } as ApiOperationInput;
}
async function fixture(context: test.TestContext, sequence: string | null = "35") {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "napcat-inline-owner-"));
    context.after(() => fs.rm(rootDir, { recursive: true, force: true }));
    const calls: Record<string, unknown>[] = [];
    const descriptors = createNapcatApiDescriptors(manifest).filter(value => value.action === "click_inline_keyboard_button");
    const operation = createNapcatApiOperations({ rootDir, route: () => route, local: () => true, readOnly: () => false,
        transport: async (url, init) => {
            const action = new URL(String(url)).pathname.slice(1);
            let data: unknown;
            if (action === "get_login_info")
                data = { user_id: 12345 };
            else if (action === "get_msg")
                data = { post_type: "message", message_type: "group", message_id: 12, group_id: 789,
                    self_id: 12345, user_id: 456, message_seq: sequence ?? undefined, message: [] };
            else {
                calls.push(JSON.parse(String(init?.body)));
                data = { privateOpaqueResponse: "must not leave native owner" };
            }
            return Response.json({ status: "ok", retcode: 0, data });
        } }, descriptors)[0];
    return { rootDir, operation, calls };
}
test("inline keyboard uses original exact message/group proof and the original durable receipt", async (context) => {
    const value = await fixture(context);
    const first = await value.operation.handler(input());
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal((first.body as {
        data: unknown;
    }).data, null);
    assert.equal((await value.operation.handler(input())).status, 200);
    assert.equal(value.calls.length, 1);
    assert.deepEqual(value.calls[0], { group_id: "789", bot_appid: "application", button_id: "button", callback_data: "private-callback", msg_seq: "35" });
    for (const entry of await fs.readdir(value.rootDir, { recursive: true })) {
        if (entry.endsWith(".json"))
            assert.doesNotMatch(await fs.readFile(path.join(value.rootDir, entry), "utf8"), /private-callback|privateOpaqueResponse/);
    }
});
test("an observed different message sequence blocks the platform callback", async (context) => {
    const value = await fixture(context, "36");
    const result = await value.operation.handler(input());
    assert.equal(result.status, 409);
    assert.equal(value.calls.length, 0);
});
test("the reviewed native protocol remains usable when the original message format has no sequence field", async (context) => {
    const value = await fixture(context, null);
    const source = input();
    const first = await value.operation.handler(source);
    assert.equal(first.status, 200, JSON.stringify(first.body));
});
