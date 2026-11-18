import assert from "node:assert/strict";
import test from "node:test";
import { openNativeDownloadFrames } from "./downloadFrames.js";
const info = { type: "stream", data_type: "file_info", file_name: "C:/native/private.bin", file_size: 3, chunk_size: 3 };
const chunk = { type: "stream", data_type: "file_chunk", index: 0, data: "YWJj", size: 3, secret: "ignored" };
const complete = { type: "response", data_type: "file_complete", total_chunks: 1, total_bytes: 3 };
const encode = (data: unknown) => JSON.stringify({ status: "ok", retcode: 0, data }) + "\r\n\r\n";
function open(response: Response, overrides = {}) {
    return openNativeDownloadFrames(response, { signal: new AbortController().signal, chunkBytes: 3, maxBytes: 100,
        maxFrameBytes: 1024, name: "source.bin", ...overrides });
}
async function collect(frames: AsyncIterable<unknown>) {
    const result = [];
    for await (const value of frames)
        result.push(value);
    return result;
}
test("native HTTP framing survives split UTF8/JSON and projects only source-safe fields", async () => {
    const bytes = Buffer.from([info, chunk, complete].map(encode).join(""));
    const stream = new ReadableStream({ start(controller) {
            for (let i = 0; i < bytes.length; i += 7)
                controller.enqueue(bytes.subarray(i, i + 7));
            controller.close();
        } });
    const frames = await collect(open(new Response(stream)).frames);
    assert.equal(frames.length, 3);
    assert.equal((frames[0] as typeof info).file_name, "source.bin");
    assert.doesNotMatch(JSON.stringify(frames), /native|secret|ignored/);
    assert.deepEqual(frames[2], complete);
});
test("completion is withheld until actual EOF and trailing native frames invalidate it", async () => {
    const invalid = open(new Response([info, chunk, complete, chunk].map(encode).join(""))).frames;
    assert.equal((await invalid.next()).done, false);
    assert.equal((await invalid.next()).done, false);
    await assert.rejects(invalid.next(), /QQ_NATIVE_STREAM_INVALID/);
    await assert.rejects(collect(open(new Response([info, chunk].map(encode).join(""))).frames), /QQ_NATIVE_STREAM_INCOMPLETE/);
});
test("complete resources reject 206, false totals, missing bytes and noncanonical chunks", async () => {
    assert.throws(() => open(new Response("partial", { status: 206 })), /QQ_NATIVE_STREAM_HTTP_REJECTED/);
    for (const bad of [{ ...chunk, index: 1 }, { ...chunk, data: "YWJj=", size: 3 }, { ...complete, total_bytes: 2 }]) {
        await assert.rejects(collect(open(new Response([info, ...(bad.data_type === "file_complete" ? [chunk] : []), bad].map(encode).join(""))).frames), /QQ_NATIVE_STREAM_INVALID/);
    }
    await assert.rejects(collect(open(new Response([{ ...info, file_size: 4 }, chunk, complete].map(encode).join(""))).frames), /QQ_NATIVE_STREAM_INVALID/);
});
test("native conversion may change original announced size but never escapes the actual byte budget", async () => {
    const wire = [{ ...info, file_size: 999 }, chunk, complete].map(encode).join("");
    assert.equal((await collect(open(new Response(wire), { allowConvertedSize: true }).frames)).length, 3);
    await assert.rejects(collect(open(new Response(wire), { allowConvertedSize: true, maxBytes: 2 }).frames), /QQ_NATIVE_STREAM_TOO_LARGE/);
    await assert.rejects(collect(open(new Response(wire), { maxFrameBytes: 20 }).frames), /QQ_NATIVE_STREAM_FRAME_TOO_LARGE/);
});
test("abort cancels and joins a delayed native body reader", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() {
            cancelled = true;
        } }));
    const controller = new AbortController(), native = open(response, { signal: controller.signal });
    const pending = native.frames.next();
    controller.abort();
    await assert.rejects(pending, /abort/i);
    assert.equal(cancelled, true);
});
