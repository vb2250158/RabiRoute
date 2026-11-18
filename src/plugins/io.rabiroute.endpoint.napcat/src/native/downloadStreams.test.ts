import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import { compileApiContract, type ApiOperationInput } from "@rabiroute/host-api/manager/apiOperationContract";
import type { GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import { createNapcatDownloadStreamOperations } from "./downloadStreams.js";

/** Fixed dummy value for injected offline test transports; never a real account credential. */
const fixtureAccessToken = "fixture-token";

const route = { id: "route", enabled: true, messageAdapters: ["napcat"], napcatInstances: [
        { id: "instance", enabled: true, httpUrl: "http://127.0.0.1:12345", botUserId: "12345", accessToken: fixtureAccessToken }
    ] } as GatewayDefinition;
const envelope = (data: unknown) => ({ status: "ok", retcode: 0, data });
function input(params: unknown): ApiOperationInput {
    return { request: { headers: {} } as IncomingMessage, response: {}, url: new URL("http://fixture.invalid"), path: {}, query: {},
        body: { routeId: "route", instanceId: "instance", params } } as ApiOperationInput;
}
function fixture(options: {
    changed?: boolean;
    status?: number;
} = {}) {
    const calls: {
        action: string;
        body: Record<string, unknown>;
    }[] = [];
    let identities = 0;
    const operations = createNapcatDownloadStreamOperations({ route: () => route, local: () => true, transport: async (url, init) => {
            const action = new URL(String(url)).pathname.slice(1), body = JSON.parse(String(init?.body));
            calls.push({ action, body });
            if (action === "get_login_info")
                return Response.json(envelope({ user_id: options.changed && identities++ ? "54321" : "12345" }));
            if (action === "get_msg")
                return Response.json(envelope({ post_type: "message", message_type: "private", message_id: 12,
                    self_id: 12345, user_id: 456, message: [{ type: "record", data: { file: "/native-original-cache-id", url: "https://secret.invalid/signed" } }] }));
            return new Response([
                { type: "stream", data_type: "file_info", file_name: "C:/private/native-cache", file_size: 3, chunk_size: body.chunk_size },
                { type: "stream", data_type: "file_chunk", index: 0, size: 3, data: "YWJj" },
                { type: "response", data_type: "file_complete", total_chunks: 1, total_bytes: 3 }
            ].map(value => JSON.stringify(envelope(value)) + "\r\n\r\n").join(""), { status: options.status ?? 200 });
        } });
    return { operations, calls };
}
async function collect(stream: AsyncIterable<unknown>) {
    const result = [];
    for await (const value of stream)
        result.push(value);
    return result;
}
test("group native cache reference reaches the real fixed streaming action and final identity fence", async () => {
    const f = fixture(), operation = f.operations[0];
    const result = await operation.handler(input({ group: { groupId: "789", fileId: "a".repeat(32) }, chunk_size: 3 }));
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.ok(result.stream?.frames);
    const frames = await collect(result.stream.frames);
    const compiled = compileApiContract({ contract: operation.contract });
    const validateFrame = compiled.streamValidators.get(compiled.contract.responses["200"])!;
    for (const frame of frames)
        assert.equal(validateFrame(frame), true, JSON.stringify(validateFrame.errors));
    assert.equal(frames.length, 3);
    assert.doesNotMatch(JSON.stringify(frames), /C:|private|token/);
    assert.deepEqual(f.calls.map(value => value.action), ["get_login_info", "download_file_stream", "get_login_info"]);
    assert.deepEqual(f.calls[1].body, { file_id: "a".repeat(32), chunk_size: 3 });
});
test("record native stream uses the exact message cache ID and reviewed conversion format", async () => {
    const f = fixture(), operation = f.operations[1];
    const result = await operation.handler(input({ source: { kind: "private", targetId: "456", messageId: "12", attachmentIndex: 0 }, out_format: "wav", chunk_size: 3 }));
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.ok(result.stream?.frames);
    await collect(result.stream.frames);
    assert.deepEqual(f.calls.find(value => value.action === "download_file_record_stream")?.body, { file_id: "/native-original-cache-id", chunk_size: 3, out_format: "wav" });
});
test("caller URL/path, unknown format and double source are rejected before provider IO", async () => {
    for (const params of [{ file: "https://caller.invalid" }, { source: { kind: "private", targetId: "456", messageId: "12", attachmentIndex: 0 }, out_format: "exe" },
        { group: { groupId: "789", fileId: "a".repeat(32) }, source: { kind: "private", targetId: "456", messageId: "12", attachmentIndex: 0 } }]) {
        const f = fixture();
        const result = await f.operations[params.out_format ? 1 : 0].handler(input(params));
        assert.equal(result.status, 400);
        assert.equal(f.calls.length, 0);
    }
});
test("206 never opens a full-resource stream and changed QQ never emits completion", async () => {
    const params = { group: { groupId: "789", fileId: "a".repeat(32) }, chunk_size: 3 };
    const partial = fixture({ status: 206 });
    assert.equal((await partial.operations[0].handler(input(params))).status, 503);
    const changed = fixture({ changed: true }), result = await changed.operations[0].handler(input(params));
    assert.ok(result.stream?.frames);
    await assert.rejects(collect(result.stream.frames), /QQ_.*ACCOUNT|QQ_.*IDENTITY/);
});
