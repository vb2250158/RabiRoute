import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import type { ApiOperationInput } from "@rabiroute/host-api/manager/apiOperationContract";
import type { GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import { createNapcatShareLinkOperation } from "./shareLink.js";
const route = { id: "route", enabled: true, messageAdapters: ["napcat"], napcatInstances: [
        { id: "instance", enabled: true, httpUrl: "http://127.0.0.1:12345", botUserId: "12345" }
    ] } as GatewayDefinition;
function fixture(shareLink: string, result = 0) {
    const calls: string[] = [];
    const operation = createNapcatShareLinkOperation({ route: () => route, local: () => true, transport: async (url, init) => {
            const action = new URL(String(url)).pathname.slice(1);
            calls.push(action);
            const data = action === "get_login_info" ? { user_id: 12345 } : action === "get_msg" ? {
                post_type: "message", message_type: "private", message_id: 12, self_id: 12345, user_id: 456,
                message: [{ type: "flashtransfer", data: { fileSetId: "native-fileset" } }]
            } : { result, shareLink };
            if (action === "get_share_link")
                assert.deepEqual(JSON.parse(String(init?.body)), { fileset_id: "native-fileset" });
            return Response.json({ status: "ok", retcode: 0, data });
        } });
    return { operation, calls };
}
function input(): ApiOperationInput {
    return { request: { headers: {} } as IncomingMessage, response: {}, path: {}, query: {}, url: new URL("http://fixture.invalid"),
        body: { routeId: "route", instanceId: "instance", params: { source: { kind: "private", targetId: "456", messageId: "12" } } } } as ApiOperationInput;
}
test("requested share-link capabilities keep required parameters and are returned only for the exact source", async () => {
    const value = fixture("https://share.example.invalid/files?share=required%2Bvalue&expiry=123");
    const result = await value.operation.handler(input());
    assert.equal(result.status, 200);
    assert.equal((result.body as {
        shareLink: string;
    }).shareLink, "https://share.example.invalid/files?share=required%2Bvalue&expiry=123");
    assert.equal((result.body as {
        access: string;
    }).access, "link-holder");
    assert.equal(value.calls.at(-1), "get_login_info");
});
test("share links reject unsafe protocols, credentials, control characters and native negative results", async () => {
    for (const link of ["file:///private", "javascript:alert(1)", "https://user:password@share.example.invalid/file", "https://share.example.invalid/\nfile"]) {
        const value = fixture(link);
        const result = await value.operation.handler(input());
        assert.equal(result.status, 503);
        assert.doesNotMatch(JSON.stringify(result.body), /password|javascript|private/);
    }
    assert.equal((await fixture("https://share.example.invalid", 1).operation.handler(input())).status, 503);
});
