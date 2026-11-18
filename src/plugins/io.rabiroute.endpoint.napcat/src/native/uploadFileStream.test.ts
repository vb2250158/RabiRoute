import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import { uploadNapcatManagedFileStream, selectNapcatApiInstance, type NapcatApiTransportContext } from "../manager/napcatApiTransport.js";
const route = { id: "route", enabled: true, messageAdapters: ["napcat"], napcatInstances: [
        { id: "instance", enabled: true, httpUrl: "http://127.0.0.1:12345", botUserId: "12345" }
    ] } as GatewayDefinition;
async function fixture(context: test.TestContext, lost = false) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "napcat-native-chunk-"));
    context.after(() => fs.rm(directory, { recursive: true, force: true }));
    const bytes = Buffer.from("cross-native-chunks");
    const filePath = path.join(directory, "source.bin");
    await fs.writeFile(filePath, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const chunks: Buffer[] = [];
    let completed = false;
    let requests = 0;
    const owner: NapcatApiTransportContext = { route: () => route, local: () => true, transport: async (url, init) => {
            if (new URL(String(url)).pathname === "/get_login_info")
                return Response.json({ status: "ok", retcode: 0, data: { user_id: 12345 } });
            requests++;
            const body = JSON.parse(String(init?.body));
            assert.equal(body.reset, undefined);
            assert.equal(body.verify_only, undefined);
            let data: unknown;
            if (body.chunk_data) {
                if (lost)
                    throw Error("original native response lost");
                assert.equal(body.chunk_index, chunks.length);
                assert.equal(body.expected_sha256, sha256);
                assert.equal(body.filename, "a".repeat(64) + ".bin");
                chunks.push(Buffer.from(body.chunk_data, "base64"));
                data = { type: "stream", stream_id: body.stream_id, status: "chunk_received", received_chunks: chunks.length, total_chunks: body.total_chunks };
            }
            else {
                assert.equal(body.is_complete, true);
                assert.deepEqual(Buffer.concat(chunks), bytes);
                completed = true;
                data = { type: "response", stream_id: body.stream_id, status: "file_complete", received_chunks: chunks.length,
                    total_chunks: chunks.length, file_path: "C:/native-only/upload.bin", file_size: bytes.length, sha256 };
            }
            return Response.json({ status: "ok", retcode: 0, data });
        } };
    const signal = AbortSignal.timeout(2000);
    const selection = selectNapcatApiInstance(owner, { headers: {} } as IncomingMessage, "route", "instance", signal);
    return { owner, selection, signal, attachment: { path: filePath, sha256 }, state: () => ({ completed, requests }) };
}
test("native upload_file_stream uses original chunk acknowledgements and only accepts complete matching SHA/size", async (context) => {
    const value = await fixture(context);
    const result = await uploadNapcatManagedFileStream(value.owner, value.selection, { streamId: "a".repeat(64), chunkBytes: 5, fileRetentionMs: 300000 }, value.attachment, value.signal);
    assert.equal(result.nativePath, "C:/native-only/upload.bin");
    assert.equal(result.sha256, value.attachment.sha256);
    assert.equal(value.state().completed, true);
});
test("native upload chunk response loss never resets, completes or automatically resubmits the original chunk", async (context) => {
    const value = await fixture(context, true);
    await assert.rejects(uploadNapcatManagedFileStream(value.owner, value.selection, { streamId: "a".repeat(64), chunkBytes: 5, fileRetentionMs: 300000 }, value.attachment, value.signal), /QQ_API_UPSTREAM_UNAVAILABLE/);
    assert.deepEqual(value.state(), { completed: false, requests: 1 });
});
