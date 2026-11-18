import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import type { ApiOperationInput } from "@rabiroute/host-api/manager/apiOperationContract";
import type { GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import { createNapcatNativeEgressOperations } from "./egressOperations.js";
test("native compatibility HTTP operations submit the same admitted request to the original agent.send owner", async () => {
    const request = { headers: {} } as IncomingMessage;
    const route = { id: "route", enabled: true, messageAdapters: ["napcat"], napcatInstances: [
            { id: "selected", enabled: true, httpUrl: "http://127.0.0.1:12345", botUserId: "12345" }
        ] } as GatewayDefinition;
    let submissions = 0;
    const operations = createNapcatNativeEgressOperations({ local: () => true, route: () => route,
        transport: async () => {
            throw Error("HTTP compatibility entry must not bypass the original outbox");
        },
        submitAgentSendVariant: async (admitted, body, authorize) => {
            submissions++;
            assert.equal(admitted, request);
            authorize();
            assert.equal(body.deliveryId, "original-intent");
            assert.deepEqual(body.sender, { agentType: "codex", sessionId: "original-source" });
            assert.equal(body.channel, "napcat");
            assert.equal(body.payload.type, "napcat.native-send_group_ai_record");
            return { statusCode: 202, body: { status: "uncertain", deliveryId: "original-intent" } };
        } });
    const operation = operations.find(value => value.contract.operationId === "agent.qq.onebot.send_group_ai_record")!;
    const input = { request, response: {}, path: {}, query: {}, url: new URL("http://fixture.invalid"), body: {
            deliveryId: "original-intent", sender: { agentType: "codex", sessionId: "original-source" }, routeId: "route",
            params: { target: "group", groupId: "789", instanceId: "selected" }, data: { character: "voice", text: "actual text" }
        } } as ApiOperationInput;
    assert.deepEqual(await operation.handler(input), { status: 202, body: { status: "uncertain", deliveryId: "original-intent" } });
    assert.equal(submissions, 1);
    assert.equal((await operation.handler({ ...input, body: { ...input.body as object, action: "raw-action" } })).status, 400);
    assert.equal(submissions, 1);
});
