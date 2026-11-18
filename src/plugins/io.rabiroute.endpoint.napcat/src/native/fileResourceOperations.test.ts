import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { ApiOperationInput } from "@rabiroute/host-api/manager/apiOperationContract";
import type { GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import { createNapcatFileResourceOperations, type NapcatFileResourceContext } from "./fileResourceOperations.js";
import { memoryResourceObjects } from "./artifactObjects.fixture.js";
const route = { id: "route", enabled: true, messageAdapters: ["napcat"], napcatInstances: [
        { id: "instance", enabled: true, httpUrl: "http://127.0.0.1:12345", botUserId: "12345" }
    ] } as GatewayDefinition;
async function fixture(context: test.TestContext, loseNative = false) {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "napcat-file-resource-"));
    context.after(() => fs.rm(rootDir, { recursive: true, force: true }));
    const bytes = Buffer.from("real managed file");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const source = path.join(rootDir, "source.bin");
    await fs.writeFile(source, bytes);
    const request = { headers: {} } as IncomingMessage;
    const calls: string[] = [];
    const chunks: Buffer[] = [];
    let leases = 0;
    let activeLeases = 0;
    const store = memoryResourceObjects();
    const owner: NapcatFileResourceContext = {
        rootDir, route: () => route, local: () => true, readOnly: () => false, resourceObjects: store.resources, protectedResourceObjects: store.protectedResources,
        withManagedAttachment: async (admitted, reference, authorize, operation) => {
            assert.equal(admitted, request);
            assert.deepEqual(reference, { fileId: "managed-source", fileSha256: sha256 });
            authorize();
            leases++;
            activeLeases++;
            try {
                return await operation({ path: source, fileName: "source.bin", sha256, bytes: bytes.length });
            }
            finally {
                activeLeases--;
            }
        },
        transport: async (url, init) => {
            const action = new URL(String(url)).pathname.slice(1);
            calls.push(action);
            if (action === "get_login_info")
                return Response.json({ status: "ok", retcode: 0, data: { user_id: 12345 } });
            let payload: Record<string, unknown>;
            if (init?.body instanceof ReadableStream)
                payload = JSON.parse(await new Response(init.body).text());
            else
                payload = JSON.parse(String(init?.body));
            if (loseNative)
                throw Error("native response closed");
            let data: unknown;
            if (action === "download_file") {
                assert.equal(activeLeases, 1);
                assert.deepEqual(Buffer.from(String(payload.base64), "base64"), bytes);
                data = { file: "C:/native-only/cache/private-file" };
            }
            else if (action === "upload_file_stream") {
                assert.equal(activeLeases, 1);
                if (payload.chunk_data) {
                    chunks.push(Buffer.from(String(payload.chunk_data), "base64"));
                    data = { type: "stream", stream_id: payload.stream_id, status: "chunk_received", received_chunks: chunks.length, total_chunks: payload.total_chunks };
                }
                else {
                    assert.deepEqual(Buffer.concat(chunks), bytes);
                    data = { type: "response", stream_id: payload.stream_id, status: "file_complete", received_chunks: chunks.length,
                        total_chunks: chunks.length, file_path: "C:/native-only/cache/private-file", file_size: bytes.length, sha256 };
                }
            }
            else {
                assert.equal(action, "create_flash_task");
                assert.deepEqual(payload.files, ["C:/native-only/cache/private-file"]);
                data = { result: 0, opaqueNativeTask: "not-guessed-as-fileset" };
            }
            return Response.json({ status: "ok", retcode: 0, data });
        }
    };
    const input = (action: string): ApiOperationInput => ({ request, response: {}, path: {}, query: {}, url: new URL("http://fixture.invalid"), body: {
            routeId: "route", instanceId: "instance", deliveryId: "original-" + action,
            params: action === "create_flash_task" ? { attachments: [{ fileId: "managed-source", fileSha256: sha256 }] }
                : { attachment: { fileId: "managed-source", fileSha256: sha256 } }
        } } as ApiOperationInput);
    return { owner, input, calls, state: () => ({ leases, activeLeases }) };
}
for (const action of ["download_file", "upload_file_stream", "create_flash_task"])
    test(`${action} uses the actual original managed lease and preserves its durable native result`, async (context) => {
        const value = await fixture(context);
        const operation = createNapcatFileResourceOperations(value.owner).find(item => item.contract.operationId.endsWith("." + action))!;
        const first = await operation.handler(value.input(action));
        const second = await operation.handler(value.input(action));
        assert.equal(first.status, 200, JSON.stringify(first.body));
        assert.equal(second.status, 200);
        assert.equal(value.state().leases, 1);
        assert.equal(value.state().activeLeases, 0);
        assert.doesNotMatch(JSON.stringify(first.body), /C:|native-only|private-file|opaqueNativeTask/);
        if (action === "create_flash_task")
            assert.equal((first.body as {
                data: {
                    acknowledged: boolean;
                };
            }).data.acknowledged, true);
        else
            assert.match((first.body as {
                data: {
                    id: string;
                };
            }).data.id, /^[a-f0-9]{64}$/);
    });
test("uncertain staging never reacquires the lease or replays the original native file operation", async (context) => {
    const value = await fixture(context, true);
    const operation = createNapcatFileResourceOperations(value.owner)[0];
    assert.equal((await operation.handler(value.input("download_file"))).status, 202);
    assert.equal((await operation.handler(value.input("download_file"))).status, 202);
    assert.equal(value.state().leases, 1);
    assert.equal(value.calls.filter(action => action === "download_file").length, 1);
});
test("native file references are real inputs to the flash task owner without exposing or accepting a caller path", async (context) => {
    const value = await fixture(context);
    const operations = createNapcatFileResourceOperations(value.owner);
    const staged = await operations[0].handler(value.input("download_file"));
    assert.equal(staged.status, 200);
    const reference = (staged.body as {
        data: {
            id: string;
            action: string;
            deliveryId: string;
        };
    }).data;
    const request = value.input("create_flash_task");
    (request.body as {
        params: unknown;
    }).params = { attachments: [{ nativeFile: { id: reference.id, action: reference.action, deliveryId: reference.deliveryId } }] };
    assert.equal((await operations[2].handler(request)).status, 200);
    assert.equal(value.state().leases, 1);
});
