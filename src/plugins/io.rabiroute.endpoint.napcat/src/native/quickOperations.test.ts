// Inert test credential for the isolated native fixture; never used with a real service.
const fixtureAuthToken = "test-only-unusable-auth-value";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import type { GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import type { ApiOperationInput } from "@rabiroute/host-api/manager/apiOperationContract";
import type { MessageEndpointVariantSendInput } from "@rabiroute/plugin-sdk";
import { readDurableDeliveryReceipt } from "@rabiroute/host-api/manager/durableDeliveryIdempotency";
import { createNapcatApiOperations, type NapcatApiDescriptor } from "../manager/napcatApiOperations.js";
import { ResourceCache } from "../../../../manager/resourceCache.js";
import { createProtectedResourceObjects } from "../../../../manager/protectedResourceObjects.js";
import { createAsyncLocalSecretProtector } from "../../../../shared/localSecretProtection.js";
import { captureNapcatQuickRequestContext, readNapcatQuickRequestContext } from "./quickOperationContexts.js";
import type { NapcatApiSelection } from "../manager/napcatApiTransport.js";
import { createNapcatQuickOperation, createNapcatQuickReplyProducer, quickOperationChildId, type NapcatQuickOperationContext } from "./quickOperations.js";
function fixture(t: test.TestContext) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quick-operation-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const route = { id: "route", enabled: true, messageAdapters: ["napcat"], napcatInstances: [{ id: "instance", enabled: true, httpUrl: "http://localhost:12345", accessToken: fixtureAuthToken, botUserId: "12345" }] } as GatewayDefinition;
    const calls: Array<{
        action: string;
        params: Record<string, unknown>;
    }> = [], submits: unknown[] = [];
    let failAction = "", replyId = "100", actualSender = "456", readonly = false, group = "789", messageKind: "group" | "private" = "group";
    const context: NapcatQuickOperationContext = { rootDir: root, route: () => route, local: () => true, readOnly: () => readonly,
        protectedResourceObjects: createProtectedResourceObjects(new ResourceCache(root), createAsyncLocalSecretProtector(root), "message-endpoint-private-metadata@1"),
        transport: async (url, init) => {
            const action = new URL(String(url)).pathname.slice(1), params = JSON.parse(String(init?.body));
            calls.push({ action, params });
            if (action === failAction)
                throw Error("native unknown");
            const data = action === "get_login_info" ? { user_id: "12345" } : action === "get_msg" ? { post_type: "message", message_type: messageKind, message_id: 12, ...(messageKind === "group" ? { group_id: group } : { user_id: actualSender }), self_id: 12345, sender: { user_id: actualSender }, message: [{ type: "text", data: { text: "original" } }] } : action.startsWith("send_") ? { message_id: replyId } : null;
            return Response.json({ status: "ok", retcode: 0, data });
        },
        submitAgentSendVariant: async (request, body, authorize) => {
            authorize();
            submits.push({ request, body });
            return { statusCode: 200, body: { status: "sent", sentMessageId: "100", deliveryId: body.deliveryId } };
        }, invokeNativeAction: async () => {
            throw Error("not initialized");
        }
    };
    const string = { type: "string" };
    const descriptors: NapcatApiDescriptor[] = ["delete_msg", "set_group_kick", "set_group_ban", "set_friend_add_request", "set_group_add_request"].map(action => ({ action, aliases: [], title: action, description: "fixed fixture contract", version: "4.18.4", mode: "mutation", parameters: { type: "object", additionalProperties: false, properties: { message_id: string, group_id: string, user_id: string, duration: { type: "integer" }, flag: string, eventRef: string, approve: { type: "boolean" }, sub_type: string, remark: string, reason: string } }, response: { type: "null" } }));
    const nativeDescriptors = descriptors.map(descriptor => descriptor.action === "set_friend_add_request" || descriptor.action === "set_group_add_request"
        ? { ...descriptor, sourceInput: "request-event" as const, nativeParameters: { type: "object", additionalProperties: false, required: ["flag", "approve"], properties: { flag: string, approve: { type: "boolean" }, remark: string, reason: string, count: { type: "integer" } } } }
        : descriptor);
    const native = createNapcatApiOperations({ ...context, resolveQuickRequest: (selection: NapcatApiSelection, eventRef: string, signal: AbortSignal) => readNapcatQuickRequestContext(context.protectedResourceObjects, selection, eventRef, selection.assertCurrent, signal) }, nativeDescriptors);
    context.invokeNativeAction = (action, input) => Promise.resolve(native.find(item => item.contract.operationId === `agent.qq.onebot.${action}`)!.handler(input));
    const operation = createNapcatQuickOperation(context), request = { headers: {} } as IncomingMessage;
    assert.deepEqual(operation.contract.aliases, ["agent.qq.onebot..handle_quick_operation", "agent.qq.onebot..handle_quick_operation_async", "agent.qq.onebot..handle_quick_operation_rate_limited"]);
    assert.equal(operation.contract.pathTemplate, "/api/agent/qq/onebot/.handle_quick_operation");
    const run = (body: Record<string, unknown>, signal?: AbortSignal) => operation.handler({ request, signal, url: new URL("http://localhost/api/agent/qq/onebot/.handle_quick_operation"), path: {}, query: {}, body: { routeId: "route", instanceId: "instance", ...body } } as ApiOperationInput);
    return { context, route, calls, submits, run, request, setFail: (action: string) => failAction = action, setReplyId: (value: string) => replyId = value, setSender: (value: string) => actualSender = value, setGroup: (value: string) => group = value, setMessageKind: (value: "group" | "private") => messageKind = value, setReadonly: () => readonly = true };
}
const source = { kind: "group", targetId: "789", messageId: "12" };
test("source-bound reply and native effects use original request/parent-derived receipts once, without fire-and-forget quick action", async (t) => {
    const f = fixture(t), body = { deliveryId: "original-parent", source, operation: { reply: "all caller text", at_sender: true, delete: true, kick: true, ban: true, ban_duration: 60 }, sender: { agentType: "codex", sessionId: "original-task" } };
    const first = await f.run(body);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal((await f.run(body)).status, 200);
    assert.equal(f.submits.length, 1);
    const submit = f.submits[0] as {
        request: IncomingMessage;
        body: Record<string, unknown>;
    };
    assert.equal(submit.request, f.request);
    assert.equal(submit.body.deliveryId, quickOperationChildId("original-parent", "reply"));
    assert.deepEqual(submit.body.sender, body.sender);
    for (const action of ["delete_msg", "set_group_kick", "set_group_ban"])
        assert.equal(f.calls.filter(row => row.action === action).length, 1);
    assert(!f.calls.some(row => row.action.includes("quick")));
    assert.equal((await f.run({ ...body, operation: { delete: true } })).status, 409);
});
test("partial/unknown child retains its original parent and does not replay a completed reply or unknown native mutation", async (t) => {
    const f = fixture(t);
    f.setFail("set_group_kick");
    const body = { deliveryId: "partial-original", source, operation: { reply: "reply before unknown", kick: true, ban: true, ban_duration: 60 }, sender: { agentType: "codex", sessionId: "original-task" } };
    const first = await f.run(body);
    assert.equal(first.status, 202);
    assert.equal(f.submits.length, 1);
    assert.equal((await f.run(body)).status, 202);
    assert.equal(f.submits.length, 1);
    assert.equal(f.calls.filter(row => row.action === "set_group_kick").length, 1);
    assert.equal(f.calls.filter(row => row.action === "set_group_ban").length, 0);
    assert(!JSON.stringify(first.body).includes("PRIVATE_AUTH"));
});
test("only sealed real request flags reach fixed approval owner and public raw context/flag are rejected before effects", async (t) => {
    const f = fixture(t), instance = f.route.napcatInstances![0]!;
    const eventRef = await captureNapcatQuickRequestContext(f.context.protectedResourceObjects, { routeId: "route", instanceId: "instance", botUserId: "12345", httpUrl: instance.httpUrl, accessToken: instance.accessToken ?? "" }, { post_type: "request", request_type: "friend", self_id: 12345, user_id: 456, flag: "PRIVATE_FLAG" }, () => {
    }, new AbortController().signal);
    const body = { deliveryId: "approve-original", source: { eventRef }, operation: { approve: false, remark: "real remark" } };
    assert.equal((await f.run(body)).status, 200);
    assert.equal((await f.run(body)).status, 200);
    assert.equal(f.calls.filter(row => row.action === "set_friend_add_request").length, 1);
    assert.equal(f.calls.find(row => row.action === "set_friend_add_request")!.params.flag, "PRIVATE_FLAG");
    assert.equal((await f.run({ ...body, deliveryId: "raw", context: { flag: "spoof" } })).status, 400);
    assert.equal((await f.run({ ...body, deliveryId: "wrong", source: { eventRef: "a".repeat(64) } })).status, 404);
    assert.equal((await f.run({ ...body, deliveryId: "raw-flag", source: { flag: "spoof" } })).status, 400);
    const receipts = JSON.stringify(readDurableDeliveryReceipt(f.context.rootDir, "napcat-onebot-actions", "approve-original"));
    assert(!receipts.includes("PRIVATE_FLAG"));
    const childReceipt = JSON.stringify(readDurableDeliveryReceipt(f.context.rootDir, "napcat-onebot-actions", quickOperationChildId("approve-original", "approve")));
    assert(!childReceipt.includes("PRIVATE_FLAG"), "the original Native child receipt persists only the sealed source selector");
    const groupRef = await captureNapcatQuickRequestContext(f.context.protectedResourceObjects, { routeId: "route", instanceId: "instance", botUserId: "12345", httpUrl: instance.httpUrl, accessToken: instance.accessToken ?? "" }, { post_type: "request", request_type: "group", sub_type: "invite", group_id: 789, self_id: 12345, user_id: 456, flag: "PRIVATE_GROUP_FLAG" }, () => {
    }, new AbortController().signal);
    assert.equal((await f.run({ deliveryId: "group-approve-original", source: { eventRef: groupRef }, operation: { approve: false, reason: "decline reason" } })).status, 200);
    const groupCall = f.calls.find(row => row.action === "set_group_add_request")!;
    assert.equal(groupCall.params.flag, "PRIVATE_GROUP_FLAG");
    assert.equal(groupCall.params.reason, "decline reason");
    assert.equal(groupCall.params.sub_type, undefined);
});
test("read-only, CQ media, wrong target and missing sender never reach an effect owner", async (t) => {
    const f = fixture(t);
    const cancelled = new AbortController();
    cancelled.abort();
    const beforeCancel = f.calls.length;
    assert((await f.run({ deliveryId: "cancelled-original", source, operation: { delete: true } }, cancelled.signal)).status >= 400);
    assert.equal(f.calls.length, beforeCancel);
    assert.equal((await f.run({ deliveryId: "cq", source, operation: { reply: "[CQ:image,file=private]" }, sender: { agentType: "codex", sessionId: "task" } })).status, 422);
    assert.equal((await f.run({ deliveryId: "sender", source, operation: { reply: "text" } })).status, 400);
    f.setGroup("999");
    assert.equal((await f.run({ deliveryId: "wrong", source, operation: { delete: true } })).status, 409);
    f.setReadonly();
    assert.equal((await f.run({ deliveryId: "readonly", source, operation: { delete: true } })).status, 403);
    assert.equal(f.submits.length, 0);
    assert(!f.calls.some(row => row.action === "delete_msg"));
});
test("actual quick-reply producer reconstructs quote/mention and requires exact sender, target and real nonzero message ID", async (t) => {
    const f = fixture(t), producer = createNapcatQuickReplyProducer(f.context);
    const input = { deliveryId: "original-reply", gatewayId: "route", routeId: "route", target: { target: "group", groupId: "789", instanceId: "instance", source, senderUserId: "456" }, data: { text: "all caller text", atSender: true }, sourceDataDirs: [] } as MessageEndpointVariantSendInput;
    assert.equal(producer.variant.readText(input.data), "all caller text");
    assert.deepEqual(await producer.send(input), { messageId: "100" });
    assert.deepEqual(f.calls.find(row => row.action === "send_group_msg")!.params.message, [{ type: "reply", data: { id: "12" } }, { type: "at", data: { qq: "456" } }, { type: "text", data: { text: "all caller text" } }]);
    f.setSender("777");
    await assert.rejects(producer.send(input), /SOURCE_CHANGED/);
    f.setSender("456");
    f.setReplyId("0");
    await assert.rejects(producer.send(input), /MESSAGE_ID_REQUIRED/);
    f.setGroup("999");
    await assert.rejects(producer.send(input));
    const privateFixture = fixture(t);
    privateFixture.setMessageKind("private");
    const privateProducer = createNapcatQuickReplyProducer(privateFixture.context);
    assert.deepEqual(await privateProducer.send({ ...input, target: { target: "private", userId: "456", instanceId: "instance", source: { kind: "private", targetId: "456", messageId: "12" }, senderUserId: "456" } }), { messageId: "100" });
    assert.deepEqual(privateFixture.calls.find(row => row.action === "send_private_msg")!.params.message, [{ type: "text", data: { text: "all caller text" } }]);
});
