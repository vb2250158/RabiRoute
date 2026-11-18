import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import { compileApiContract, type ApiOperationInput } from "@rabiroute/host-api/manager/apiOperationContract";
import type { GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import { createNapcatTestStreamOperation } from "./testStream.js";
const route = { id: "route", enabled: true, messageAdapters: ["napcat"], napcatInstances: [
        { id: "instance", enabled: true, httpUrl: "http://127.0.0.1:12345", botUserId: "12345" }
    ] } as GatewayDefinition;
function input(error = false): ApiOperationInput {
    return { request: { headers: {} } as IncomingMessage, response: {}, path: {}, query: {}, url: new URL("http://fixture.invalid"),
        body: { routeId: "route", instanceId: "instance", params: { error } } } as ApiOperationInput;
}
function fixture(incomplete = false) {
    const calls: string[] = [];
    const operation = createNapcatTestStreamOperation({ route: () => route, local: () => true, transport: async (url, init) => {
            const action = new URL(String(url)).pathname.slice(1);
            calls.push(action);
            if (action === "get_login_info")
                return Response.json({ status: "ok", retcode: 0, data: { user_id: 12345 } });
            assert.equal(action, "test_download_stream");
            const frames: Array<Record<string, unknown>> = Array.from({ length: 10 }, (_, index) => ({ status: "ok", retcode: 0,
                data: { type: "stream", data_type: "data_chunk", data: `Index-> ${index + 1}`, secret: "not-returned" } }));
            const fail = JSON.parse(String(init?.body)).error;
            if (!incomplete)
                frames.push(fail ? { status: "failed", retcode: 1400, data: { secret: "private-platform-detail" } }
                    : { status: "ok", retcode: 0, data: { type: "response", data_type: "data_complete", data: "Stream transmission complete" } });
            return new Response(frames.map(value => JSON.stringify(value) + "\r\n\r\n").join(""));
        } });
    return { operation, calls };
}
test("the registered native diagnostic stream reaches its actual action and yields ten frames plus EOF completion", async () => {
    const value = fixture();
    const response = await value.operation.handler(input());
    assert.equal(response.status, 200);
    assert.ok(response.stream?.frames);
    const compiled = compileApiContract({ contract: value.operation.contract });
    const validateFrame = compiled.streamValidators.get(compiled.contract.responses["200"])!;
    const frames = [];
    for await (const frame of response.stream.frames) {
        assert.equal(validateFrame(frame), true, JSON.stringify(validateFrame.errors));
        frames.push(frame);
    }
    assert.equal(frames.length, 11);
    assert.doesNotMatch(JSON.stringify(frames), /secret|not-returned/);
    assert.deepEqual(value.calls, ["get_login_info", "test_download_stream", "get_login_info"]);
});
test("deliberate native errors and missing EOF completion never become successful stream completion", async () => {
    for (const value of [fixture(), fixture(true)]) {
        const response = await value.operation.handler(input(true));
        assert.ok(response.stream?.frames);
        let count = 0;
        await assert.rejects(async () => {
            for await (const _ of response.stream!.frames!)
                count++;
        }, /QQ_NATIVE_(STREAM_REJECTED|TEST_STREAM_INCOMPLETE)/);
        assert.equal(count, 10);
    }
});
