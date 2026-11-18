import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import { callNapcatManagedAttachment, selectNapcatApiInstance, type NapcatApiTransportContext } from "../manager/napcatApiTransport.js";

/** Fixed dummy value for injected offline test transports; never a real account credential. */
const fixtureAccessToken = "fixture-secret";

const route = { id: "route", enabled: true, messageAdapters: ["napcat"], napcatInstances: [
        { id: "instance", enabled: true, httpUrl: "http://127.0.0.1:12345", botUserId: "12345", accessToken: fixtureAccessToken }
    ] } as GatewayDefinition;
const envelope = (data: unknown) => Response.json({ status: "ok", retcode: 0, data });
async function* requestChunks(body: RequestInit["body"]) {
    assert.ok(body instanceof ReadableStream);
    const reader = body.getReader();
    try {
        while (true) {
            const value = await reader.read();
            if (value.done)
                break;
            yield Buffer.from(value.value);
        }
    }
    finally {
        reader.releaseLock();
    }
}
async function fixture(context: test.TestContext, size: number) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "napcat-managed-stream-"));
    context.after(() => fs.rm(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "original.bin");
    const file = await fs.open(filePath, "w");
    const chunk = Buffer.alloc(65537, 17);
    const hash = createHash("sha256");
    try {
        for (let offset = 0; offset < size; offset += chunk.length) {
            const value = chunk.subarray(0, Math.min(chunk.length, size - offset));
            await file.write(value);
            hash.update(value);
        }
    }
    finally {
        await file.close();
    }
    return { path: filePath, sha256: hash.digest("hex"), size };
}
function selection(context: NapcatApiTransportContext, signal: AbortSignal) {
    return selectNapcatApiInstance(context, { headers: {} } as IncomingMessage, "route", "instance", signal);
}
test("large managed attachment uploads remain bounded and preserve base64 across arbitrary chunk boundaries", async (context) => {
    const attachment = await fixture(context, 16 * 1024 * 1024 + 5);
    let received = 0;
    let largestChunk = 0;
    const hash = createHash("sha256");
    const owner: NapcatApiTransportContext = { route: () => route, local: () => true, transport: async (url, init) => {
            if (new URL(String(url)).pathname === "/get_login_info")
                return envelope({ user_id: 12345 });
            assert.ok(init?.body instanceof ReadableStream);
            assert.equal((init as RequestInit & {
                duplex?: string;
            }).duplex, "half");
            assert.equal((init.headers as Record<string, string>).authorization, `Bearer ${fixtureAccessToken}`);
            let prefix = true;
            let pending = "";
            for await (const chunk of requestChunks(init.body)) {
                largestChunk = Math.max(largestChunk, chunk.length);
                pending += chunk.toString();
                if (prefix) {
                    assert.ok(pending.startsWith('{"base64":"'));
                    pending = pending.slice(11);
                    prefix = false;
                }
                const quote = pending.indexOf('"');
                const payload = quote < 0 ? pending : pending.slice(0, quote);
                const completeCharacters = payload.length - payload.length % 4;
                const bytes = Buffer.from(payload.slice(0, completeCharacters), "base64");
                received += bytes.length;
                hash.update(bytes);
                pending = pending.slice(completeCharacters);
            }
            assert.equal(pending, '"}');
            return envelope({ file: "C:/native/file" });
        } };
    const signal = AbortSignal.timeout(30000);
    assert.deepEqual(await callNapcatManagedAttachment(owner, selection(owner, signal), { action: "download_file" }, attachment, signal), { file: "C:/native/file" });
    assert.equal(received, attachment.size);
    assert.equal(hash.digest("hex"), attachment.sha256);
    assert.ok(largestChunk < 200000, String(largestChunk));
});
test("an incorrect original SHA prevents any native upload", async (context) => {
    const attachment = await fixture(context, 17);
    let calls = 0;
    const owner: NapcatApiTransportContext = { route: () => route, local: () => true, transport: async () => {
            calls++;
            throw Error("must not reach provider");
        } };
    const signal = AbortSignal.timeout(1000);
    await assert.rejects(callNapcatManagedAttachment(owner, selection(owner, signal), { action: "download_file" }, { ...attachment, sha256: "0".repeat(64) }, signal), /QQ_NATIVE_EGRESS_ATTACHMENT_CHANGED/);
    assert.equal(calls, 0);
});
test("upload cancellation joins its body and releases the original file handle", async (context) => {
    const attachment = await fixture(context, 1024 * 1024);
    const controller = new AbortController();
    let uploadCalls = 0;
    const owner: NapcatApiTransportContext = { route: () => route, local: () => true, transport: async (url, init) => {
            if (new URL(String(url)).pathname === "/get_login_info")
                return envelope({ user_id: 12345 });
            uploadCalls++;
            assert.ok(init?.body instanceof ReadableStream);
            for await (const _ of requestChunks(init.body))
                controller.abort();
            return envelope({ file: "not-complete" });
        } };
    await assert.rejects(callNapcatManagedAttachment(owner, selection(owner, controller.signal), { action: "download_file" }, attachment, controller.signal), /QQ_NATIVE_EGRESS_ATTACHMENT_ABORTED/);
    assert.equal(uploadCalls, 1);
    await fs.rename(attachment.path, attachment.path + ".closed");
});
test("a lost native upload response is unknown and never automatically retried", async (context) => {
    const attachment = await fixture(context, 33);
    let uploadCalls = 0;
    const owner: NapcatApiTransportContext = { route: () => route, local: () => true, transport: async (url, init) => {
            if (new URL(String(url)).pathname === "/get_login_info")
                return envelope({ user_id: 12345 });
            uploadCalls++;
            assert.ok(init?.body instanceof ReadableStream);
            for await (const _ of requestChunks(init.body)) { /* Native receives the same original stream once. */
            }
            throw Error("fixture-private-upstream-url-and-detail");
        } };
    const signal = AbortSignal.timeout(1000);
    await assert.rejects(callNapcatManagedAttachment(owner, selection(owner, signal), { action: "download_file" }, attachment, signal), error => {
        assert.equal(String(error), "Error: QQ_NATIVE_EGRESS_ATTACHMENT_TRANSFER_UNKNOWN");
        return true;
    });
    assert.equal(uploadCalls, 1);
});
test("changes between the original SHA pass and upload prevent a completed JSON request", async (context) => {
    const attachment = await fixture(context, 9);
    let completedJson = false;
    const owner: NapcatApiTransportContext = { route: () => route, local: () => true, transport: async (url, init) => {
            if (new URL(String(url)).pathname === "/get_login_info") {
                await fs.writeFile(attachment.path, Buffer.alloc(attachment.size, 99));
                return envelope({ user_id: 12345 });
            }
            assert.ok(init?.body instanceof ReadableStream);
            let body = "";
            for await (const chunk of requestChunks(init.body))
                body += chunk.toString();
            JSON.parse(body);
            completedJson = true;
            return envelope({ file: "must-not-be-returned" });
        } };
    const signal = AbortSignal.timeout(1000);
    await assert.rejects(callNapcatManagedAttachment(owner, selection(owner, signal), { action: "download_file" }, attachment, signal), /QQ_NATIVE_EGRESS_ATTACHMENT_CHANGED/);
    assert.equal(completedJson, false);
});
test("a slow native receiver backpressures file reads instead of queueing the whole base64 file", async (context) => {
    const attachment = await fixture(context, 8 * 1024 * 1024);
    let uploading = false;
    let uploadReadFences = 0;
    const owner: NapcatApiTransportContext = {
        route: () => route, local: () => true,
        assertCurrent: () => {
            if (uploading)
                uploadReadFences++;
        },
        transport: async (url, init) => {
            if (new URL(String(url)).pathname === "/get_login_info")
                return envelope({ user_id: 12345 });
            uploading = true;
            await new Promise(resolve => setTimeout(resolve, 40));
            assert.ok(uploadReadFences < 8, `Native receiver has consumed0bytes but source read fences=${uploadReadFences}`);
            for await (const _ of requestChunks(init?.body)) { /* Original body is consumed under backpressure. */
            }
            return envelope({ file: "C:/native/file" });
        }
    };
    const signal = AbortSignal.timeout(5000);
    await callNapcatManagedAttachment(owner, selection(owner, signal), { action: "download_file" }, attachment, signal);
});
