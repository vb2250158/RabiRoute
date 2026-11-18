import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { MessageEndpointVariantSendInput } from "@rabiroute/plugin-sdk";
import type { GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import { createNapcatNativeEgressProducers, type NapcatNativeEgressContext } from "./egressProducers.js";

/** Fixed dummy value for injected offline test transports; never a real account credential. */
const fixtureAccessToken = "fixture-secret";

function fixture(result?: unknown, segments?: unknown[], directoryResolver?: NapcatNativeEgressContext["resolveNativeDirectory"]) {
    const route = { id: "route", enabled: true, messageAdapters: ["napcat"], napcatInstances: [
            { id: "selected", enabled: true, httpUrl: "http://127.0.0.1:12345", accessToken: fixtureAccessToken, botUserId: "12345" }
        ] } as GatewayDefinition;
    const calls: {
        action: string;
        parameters: Record<string, unknown>;
    }[] = [];
    const producers = createNapcatNativeEgressProducers({ route: () => route, resolveNativeDirectory: directoryResolver, transport: async (url, init) => {
            const action = new URL(String(url)).pathname.slice(1);
            let body = "";
            if (init?.body instanceof ReadableStream) {
                body = await new Response(init.body).text();
            }
            else {
                body = String(init?.body);
            }
            calls.push({ action, parameters: JSON.parse(body) });
            if (action === "get_msg") {
                return Response.json({ status: "ok", retcode: 0, data: { post_type: "message", message_type: "private", message_id: 12,
                        self_id: 12345, user_id: 456, message: segments ?? [{ type: "text", data: { text: "source text" } }] } });
            }
            if (action === "download_file") {
                return Response.json({ status: "ok", retcode: 0, data: { file: "C:/native-only/cache/file" } });
            }
            return Response.json({ status: "ok", retcode: 0, data: action === "get_login_info" ? { user_id: "12345", nickname: "actual bot" }
                    : result === undefined ? action === "_send_group_notice" ? null : action === "send_group_ai_record" ? { message_id: 0 } : { message_id: -123 } : result });
        } });
    return { route, calls, producers };
}
function input(data: Record<string, unknown>): MessageEndpointVariantSendInput {
    return { deliveryId: "original-intent", gatewayId: "route", routeId: "route", target: { target: "group", groupId: "789", instanceId: "selected" }, data, sourceDataDirs: [] };
}
test("notice and AI producers declare ack-only and never fabricate platform IDs", async () => {
    for (const [action, data] of [["_send_group_notice", { content: "actual notice" }], ["send_group_ai_record", { text: "actual speech", character: "voice" }]] as const) {
        const fixtureValue = fixture();
        const producer = fixtureValue.producers.find(value => value.action === action)!;
        assert.equal(producer.variant.receiptMode, "ack-only");
        assert.equal(producer.variant.readText(data), action === "_send_group_notice" ? "actual notice" : "actual speech");
        assert.deepEqual(await producer.send(input(data)), { acknowledged: true });
        assert.equal(fixtureValue.calls.filter(value => value.action === action).length, 1);
    }
});
test("album comment claims only the original OneBot acknowledgement, without interpreting opaque platform data", async () => {
    const fixtureValue = fixture({ undocumented: "opaque" });
    const producer = fixtureValue.producers.find(value => value.action === "do_group_album_comment")!;
    const data = { albumId: "album", imageId: "photo", content: "actual comment" };
    assert.equal(producer.variant.readText(data), "actual comment");
    assert.equal(producer.variant.receiptMode, "ack-only");
    assert.deepEqual(await producer.send(input(data)), { acknowledged: true });
});
test("managed online files stage bytes on the native host and never mistake the Manager path for a native path", async (context) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "napcat-online-owner-"));
    context.after(() => fs.rm(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "source.bin");
    const bytes = Buffer.from("managed file bytes");
    await fs.writeFile(filePath, bytes);
    const fixtureValue = fixture({ result: 0 });
    const producer = fixtureValue.producers.find(value => value.action === "send_online_file")!;
    const data = { attachment: { fileId: "managed-upload", fileSha256: createHash("sha256").update(bytes).digest("hex") } };
    const request = { ...input(data), target: { target: "private", userId: "456", instanceId: "selected" },
        attachments: [{ kind: "file" as const, path: filePath, fileName: "source.bin" }] };
    assert.deepEqual(producer.variant.readMedia!(data).attachments, [{ kind: "file", ...data.attachment }]);
    assert.deepEqual(await producer.send(request), { acknowledged: true });
    assert.deepEqual(fixtureValue.calls.find(value => value.action === "download_file")?.parameters, { base64: bytes.toString("base64") });
    assert.equal(fixtureValue.calls.find(value => value.action === "send_online_file")?.parameters.file_path, "C:/native-only/cache/file");
    await assert.rejects(producer.send({ ...request, data: { attachment: { ...data.attachment, fileSha256: "0".repeat(64) } } }), /QQ_NATIVE_EGRESS_ATTACHMENT_CHANGED/);
});
test("album image upload consumes only its leased managed image and declares its actual public media kind", async (context) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "napcat-album-owner-"));
    context.after(() => fs.rm(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "source.png");
    const bytes = Buffer.from("fixture image");
    await fs.writeFile(filePath, bytes);
    const fixtureValue = fixture({ native: "opaque acknowledgement" });
    const producer = fixtureValue.producers.find(value => value.action === "upload_image_to_qun_album")!;
    const data = { albumId: "album", albumName: "actual name", attachment: { fileId: "managed-image", fileSha256: createHash("sha256").update(bytes).digest("hex") } };
    assert.deepEqual(producer.variant.readMedia!(data).attachments, [{ kind: "image", ...data.attachment }]);
    assert.deepEqual(await producer.send({ ...input(data), attachments: [{ kind: "image", path: filePath, fileName: "source.png" }] }), { acknowledged: true });
    const parameters = fixtureValue.calls.find(value => value.action === "upload_image_to_qun_album")?.parameters;
    assert.equal(parameters?.file, `base64://${bytes.toString("base64")}`);
    assert.equal(fixtureValue.calls.some(value => value.action === "download_file"), false);
});
test("single-message forwarding checks the original source snapshot before native acknowledgement", async () => {
    const fixtureValue = fixture(null);
    const producer = fixtureValue.producers.find(value => value.action === "forward_friend_single_msg")!;
    const data = { source: { kind: "private", targetId: "456", messageId: "12" }, text: "source text", mediaKinds: [] };
    assert.equal(producer.variant.receiptMode, "ack-only");
    assert.deepEqual(await producer.send(input(data)), { acknowledged: true });
    assert.deepEqual(fixtureValue.calls.find(value => value.action === producer.action)?.parameters, { group_id: "789", message_id: "12" });
    await assert.rejects(producer.send(input({ ...data, text: "different" })), /QQ_NATIVE_EGRESS_SOURCE_SNAPSHOT_CHANGED/);
});
test("flash sends only the fileset from the exact native source and requires errCode0", async () => {
    const fixtureValue = fixture({ errCode: 0 }, [{ type: "flashtransfer", data: { fileSetId: "native-original-fileset" } }]);
    const producer = fixtureValue.producers.find(value => value.action === "send_flash_msg")!;
    const data = { source: { kind: "private", targetId: "456", messageId: "12" } };
    assert.deepEqual(await producer.send(input(data)), { acknowledged: true });
    assert.deepEqual(fixtureValue.calls.find(value => value.action === producer.action)?.parameters, { group_id: "789", fileset_id: "native-original-fileset" });
    const rejected = fixture({ errCode: 9 }, [{ type: "flashtransfer", data: { fileSetId: "native-original-fileset" } }]);
    await assert.rejects(rejected.producers.find(value => value.action === producer.action)!.send(input(data)), /QQ_NATIVE_EGRESS_ACK_INVALID/);
});
test("all three native forward entrypoints preserve the actual bot author and whole outgoing text", async () => {
    for (const action of ["send_forward_msg", "send_private_forward_msg", "send_group_forward_msg"]) {
        const fixtureValue = fixture();
        const producer = fixtureValue.producers.find(value => value.action === action)!;
        const request = input({ nodes: ["first", "second"] });
        const adjusted = action === "send_private_forward_msg" ? { ...request, target: { target: "private", userId: "456", instanceId: "selected" } } : request;
        assert.equal(producer.variant.readText(request.data), "first\n\nsecond");
        assert.deepEqual(await producer.send(adjusted), { messageId: "-123" });
        const native = fixtureValue.calls.find(value => value.action === action)!;
        const nodes = native.parameters.messages as {
            data: {
                user_id: string;
                nickname: string;
            };
        }[];
        assert.equal(nodes[0].data.user_id, "12345");
        assert.equal(nodes[0].data.nickname, "actual bot");
    }
});
test("closed producer shapes reject raw media URLs, spoofed nodes and ambiguous targets before native IO", async () => {
    const fixtureValue = fixture();
    const notice = fixtureValue.producers[0];
    await assert.rejects(notice.send(input({ content: "notice", image: "https://caller.invalid" })), /QQ_NATIVE_EGRESS_INPUT_INVALID/);
    await assert.rejects(notice.send({ ...input({ content: "notice" }), target: { target: "group", groupId: "789", userId: "456", instanceId: "selected" } }), /QQ_NATIVE_EGRESS_TARGET_INVALID/);
    const forward = fixtureValue.producers.find(value => value.action === "send_forward_msg")!;
    await assert.rejects(forward.send(input({ nodes: [{ user_id: "spoof", text: "bad" }] })), /QQ_NATIVE_EGRESS_INPUT_INVALID/);
    assert.equal(fixtureValue.calls.length, 0);
});
test("a malformed acknowledgement or zero forward ID remains an error for the original outbox", async () => {
    const fixtureValue = fixture({ message_id: 0 });
    const forward = fixtureValue.producers.find(value => value.action === "send_forward_msg")!;
    await assert.rejects(forward.send(input({ nodes: ["text"] })), /QQ_NATIVE_EGRESS_MESSAGE_ID_INVALID/);
    const notice = fixtureValue.producers.find(value => value.action === "_send_group_notice")!;
    await assert.rejects(notice.send(input({ content: "text" })), /QQ_NATIVE_EGRESS_ACK_INVALID/);
});
test("account and original route revocation prevent native output", async () => {
    const fixtureValue = fixture();
    fixtureValue.route.napcatInstances![0].botUserId = "54321";
    const notice = fixtureValue.producers.find(value => value.action === "_send_group_notice")!;
    await assert.rejects(notice.send(input({ content: "text" })), /QQ_API_ACCOUNT_MISMATCH/);
    assert.equal(fixtureValue.calls.some(value => value.action === "_send_group_notice"), false);
    await assert.rejects(notice.send({ ...input({ content: "text" }), routeId: "foreign-profile" }), /QQ_NATIVE_EGRESS_ROUTE_CHANGED/);
});
test("online folders hold the actual native-directory owner through acknowledgement and release it", async () => {
    let released = 0;
    const value = fixture({ result: 0 }, undefined, async (binding, signal, authorize) => {
        signal.throwIfAborted();
        authorize();
        assert.equal(binding.fileRef, "native-directory-ref");
        assert.equal(binding.instanceId, "selected");
        assert.equal(binding.botUserId, "12345");
        return { nativePath: "C:/native-only/actual-directory", name: "native-folder", snapshotDigest: "fixture",
            assertCurrent: authorize, release: () => {
                released++;
            } };
    });
    const producer = value.producers.find(item => item.action === "send_online_folder")!;
    const request = { ...input({ directoryRef: "native-directory-ref" }), target: { target: "private", userId: "456", instanceId: "selected" } };
    assert.deepEqual(await producer.send(request), { acknowledged: true });
    assert.equal(released, 1);
    assert.deepEqual(value.calls.find(item => item.action === "send_online_folder")?.parameters, {
        user_id: "456", folder_path: "C:/native-only/actual-directory", folder_name: "native-folder"
    });
    const missing = fixture();
    await assert.rejects(missing.producers.find(item => item.action === "send_online_folder")!.send(request), /QQ_NATIVE_DIRECTORY_OWNER_UNAVAILABLE/);
});
