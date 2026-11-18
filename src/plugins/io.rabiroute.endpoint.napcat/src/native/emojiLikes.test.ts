import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import type { ApiOperationInput } from "@rabiroute/host-api/manager/apiOperationContract";
import type { GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import { createNapcatEmojiLikesOperation } from "./emojiLikes.js";
const route = { id: "route", enabled: true, messageAdapters: ["napcat"], napcatInstances: [
        { id: "instance", enabled: true, httpUrl: "http://127.0.0.1:12345", botUserId: "12345" }
    ] } as GatewayDefinition;
function input(page = 0): ApiOperationInput {
    return { request: { headers: {} } as IncomingMessage, response: {}, path: {}, query: {}, url: new URL("http://fixture.invalid"),
        body: { routeId: "route", instanceId: "instance", params: {
                source: { kind: "private", targetId: "456", messageId: "12" }, emojiId: "128077", emojiType: "1", page, count: 1
            } } } as ApiOperationInput;
}
function fixture(repeatCookie = false) {
    const cookies: string[] = [];
    const operation = createNapcatEmojiLikesOperation({ route: () => route, local: () => true, transport: async (url, init) => {
            const action = new URL(String(url)).pathname.slice(1);
            const payload = JSON.parse(String(init?.body));
            const data = action === "get_login_info" ? { user_id: 12345 } : action === "get_msg" ? {
                post_type: "message", message_type: "private", message_id: 12, self_id: 12345, user_id: 456, message: []
            } : (() => {
                cookies.push(payload.cookie);
                return { result: 0, errMsg: "private diagnostic", cookie: repeatCookie ? payload.cookie : "opaque-native-cookie",
                    isFirstPage: payload.cookie === "", isLastPage: !repeatCookie && payload.cookie !== "",
                    emojiLikesList: [{ tinyId: payload.cookie ? "second" : "first", nickName: "fixture user", headUrl: "https://secret.invalid/signed-avatar" }] };
            })();
            return Response.json({ status: "ok", retcode: 0, data });
        } });
    return { operation, cookies };
}
test("emoji likes traverse only request-local native cursors and expose no cookie, avatar or diagnostic", async () => {
    const value = fixture();
    const result = await value.operation.handler(input(1));
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(value.cookies, ["", "opaque-native-cookie"]);
    assert.deepEqual((result.body as {
        entries: unknown;
    }).entries, [{ tinyId: "second", nickname: "fixture user" }]);
    assert.doesNotMatch(JSON.stringify(result.body), /cookie|signed-avatar|private diagnostic|secret\.invalid/);
    assert.equal((result.body as {
        nextPage: unknown;
    }).nextPage, null);
});
test("request-local traversal stops at actual last page and missing pages are empty", async () => {
    const value = fixture();
    const result = await value.operation.handler(input(4));
    assert.equal(result.status, 200);
    assert.equal(value.cookies.length, 2);
    assert.deepEqual((result.body as {
        entries: unknown;
    }).entries, []);
});
test("raw cookie input and unbounded traversal are rejected before native calls", async () => {
    const value = fixture();
    assert.equal((await value.operation.handler(input(Number.MAX_SAFE_INTEGER + 1))).status, 400);
    const request = input();
    (request.body as {
        params: Record<string, unknown>;
    }).params.cookie = "caller-cookie";
    assert.equal((await value.operation.handler(request)).status, 400);
    assert.equal(value.cookies.length, 0);
});
test("a stalled native cursor fails safely rather than silently returning another page", async () => {
    const value = fixture(true);
    const result = await value.operation.handler(input(1));
    assert.equal(result.status, 503);
    assert.deepEqual(result.body, { code: -1, errorCode: "QQ_EMOJI_LIKES_CONTINUATION_INVALID" });
});
