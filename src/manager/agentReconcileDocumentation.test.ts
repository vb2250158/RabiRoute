import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import http from "node:http";
import { createAgentThreadControlRoutes, type AgentThreadControlRoutesContext } from "./agentThreadControlRoutes.js";
import { handleAgentThreadRequest, type AgentThreadRequest } from "../agentThreads.js";
import { AgentRequestStore } from "../agentRequests/store.js";
import type { EndpointDeliveryReceipt } from "../agentRequests/endpointDelivery.js";
import { createAgentEndpointDelivery, type AgentEndpointDeliveryContext } from "./agentEndpointDelivery.js";

function documentedRequest(filename: string): AgentThreadRequest {
  const markdown = fs.readFileSync(new URL(`../../docs/${filename}`, import.meta.url), "utf8");
  const examples = [...markdown.matchAll(/```json\s*\n([\s\S]*?)\n```/g)]
    .map(match => { try { return JSON.parse(match[1]); } catch { return undefined; } })
    .filter(value => value?.action === "reconcile_delivery");
  assert.equal(examples.length, 1, "Publish one complete canonical reconciliation example per language");
  return examples[0];
}

for (const filename of ["rabi-agent-interfaces.md", "rabi-agent-interfaces_en.md"]) {
  test(`${filename}: documented reconciliation passes public handler and actual source resolver without resending`, async t => {
    const documented = documentedRequest(filename);
    assert.equal(documented.sourceAgentType, "agent");
    assert.equal(documented.messageSource?.type, "agent");
    if (documented.messageSource?.type !== "agent") throw new Error("The example must describe its Agent source");
    const sourceIdentity = documented.messageSource;
    assert.equal(sourceIdentity.agentAdapter, "codex");
    assert.equal(documented.messageSource?.sessionId, documented.sourceThreadId);
    assert.ok(documented.messageSource?.sessionName);
    assert.ok(documented.deliveryId);
    assert.equal(documented.prompt, undefined);
    assert.equal(documented.result, undefined);
    // Target and response-policy fields do not determine reconciliation authority.
    assert.equal(documented.threadId, undefined);
    assert.equal(documented.agentAdapter, undefined);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-doc-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    let persisted: unknown;
    const store = new AgentRequestStore({ read: () => persisted, write: value => { persisted = structuredClone(value); } });
    const reads: string[] = [];
    const factory = createAgentEndpointDelivery({
      store, registry: { localInstanceId: "fixture-manager", listInstances: () => [] },
      authority: {}, config: {}, receiptDirectory: directory,
      readLocal: async (provider: string, id: string) => {
        assert.equal(provider, "codex"); reads.push(id);
        return { id, title: "Fixture owner", cwd: directory, updatedAt: "", archived: false };
      }, localOptions: () => ({ allowedWorkspaces: [directory] })
    } as unknown as AgentEndpointDeliveryContext);
    let dispatches = 0;
    let recoveries = 0;
    const receipts = new Map<string, EndpointDeliveryReceipt>();
    const options = { ...factory.options(),
      dispatch: async (delivery: Parameters<ReturnType<typeof factory.options>["dispatch"]>[0]) => {
        dispatches++;
        const receipt: EndpointDeliveryReceipt = { deliveryId: delivery.deliveryId, generation: delivery.generation,
          endpoint: delivery.target, promptHash: delivery.promptHash, executionOptionsHash: delivery.executionOptionsHash,
          accepted: true, action: "started", transport: "fixture-only" };
        receipts.set(delivery.deliveryId, receipt);
        if (delivery.preparation.inReplyToRequestId) throw new Error("Fixture owner accepted reply but receipt was lost");
        return receipt;
      },
      reconcile: async (delivery: Parameters<ReturnType<typeof factory.options>["reconcile"]>[0]) => {
        recoveries++; return receipts.get(delivery.deliveryId);
      }
    };
    const sourceId = documented.sourceThreadId!;
    const targetId = "019f0000-0000-7000-8000-000000000002";
    const initial: AgentThreadRequest = { action: "send", sourceThreadId: sourceId, sourceAgentType: "agent",
      messageSource: documented.messageSource, agentAdapter: "codex", threadId: targetId, cwd: directory,
      responsePolicy: "required", responseInstruction: "Return fixture evidence", prompt: "Fixture only" };
    await handleAgentThreadRequest(initial, { allowedWorkspaces: [directory], endpointDelivery: options });
    const original = store.list()[0];
    const reply = await handleAgentThreadRequest({ ...initial, sourceThreadId: targetId, threadId: sourceId,
      messageSource: { ...documented.messageSource!, type: "agent", sessionId: targetId },
      inReplyToRequestId: original.id, responsePolicy: "none", result: "Fixture result", nextAction: "Fixture complete" },
    { allowedWorkspaces: [directory], endpointDelivery: options });
    assert.equal(reply.statusCode, 202);
    const deliveryId = (reply.data.delivery as { deliveryId: string }).deliveryId;
    const request: AgentThreadRequest = { ...documented, deliveryId,
      messageSource: { ...documented.messageSource!, type: "agent", workspace: directory } };
    options.resolveTarget = async () => { throw new Error("Reconciliation must use persisted target, not resolveTarget"); };
    const before = dispatches;
    const oldExample: AgentThreadRequest = { action: "reconcile_delivery", threadId: sourceId, deliveryId };
    await assert.rejects(handleAgentThreadRequest(oldExample, { allowedWorkspaces: [directory], endpointDelivery: options }), /Complete opaque session ID/);
    const routes = createAgentThreadControlRoutes({
      readJsonBody: async <T>(incoming: http.IncomingMessage): Promise<T> => {
        let bytes = "";
        for await (const chunk of incoming) bytes += String(chunk);
        return JSON.parse(bytes) as T;
      },
      jsonResponse: (response, status, body) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); },
      agentRequests: store,
      messageProcessingBoard: {
        submitOutcome: () => { throw new Error("Unexpected fixture handoff"); },
        recordHandoffReturned: () => { throw new Error("Unexpected fixture handoff return"); }
      },
      applyManagedAgentThreadDefaults: body => body,
      agentThreadRequestOptions: () => ({ allowedWorkspaces: [directory], endpointDelivery: options }),
      handleAgentThreadRequest,
      agentThreadRequestFailureData: error => ({ error: String(error) }),
      setMessageProcessingPlanBaseline: () => {},
      refreshAgentRequestReminderTimers: () => {}, publishManagerEvent: () => {},
      operationalLog: { record: () => null }, operationalError: () => undefined
    } as AgentThreadControlRoutesContext);
    const server = http.createServer((incoming, response) => { routes.handler(incoming, new URL(incoming.url!, "http://localhost"), response); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await routes.stopAcceptingAndDrain(); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture listener is unavailable");
    const post = () => fetch(`http://127.0.0.1:${address.port}/api/agent/threads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
    const pendingReceipt = receipts.get(deliveryId)!;
    receipts.delete(deliveryId);
    const unconfirmed = await post();
    assert.equal(unconfirmed.status, 202);
    const unconfirmedBody = await unconfirmed.json();
    assert.equal(unconfirmedBody.code, -1);
    assert.equal(unconfirmedBody.status, "delivery_unconfirmed");
    assert.equal(unconfirmedBody.delivery.retryable, false);
    assert.equal(unconfirmedBody.data, undefined);
    receipts.set(deliveryId, pendingReceipt);
    const confirmed = await post();
    assert.equal(confirmed.status, 200);
    const confirmedBody = await confirmed.json();
    assert.equal(confirmedBody.code, 0);
    assert.equal(confirmedBody.action, "send");
    assert.equal(confirmedBody.ok, true);
    assert.equal(confirmedBody.status, "delivered");
    assert.equal(confirmedBody.delivery.status, "accepted");
    assert.equal(confirmedBody.threadId, sourceId);
    assert.equal(confirmedBody.data, undefined);
    const repeatedHttp = await post();
    assert.equal(repeatedHttp.status, 200);
    assert.deepEqual(await repeatedHttp.json(), confirmedBody);
    const recovered = await handleAgentThreadRequest(request, { allowedWorkspaces: [directory], endpointDelivery: options });
    assert.equal(recovered.statusCode, 200);
    assert.equal(recovered.data.action, "send");
    assert.equal(recovered.data.status, "delivered");
    assert.equal(recovered.data.threadId, sourceId);
    assert.equal(store.get(original.id)?.status, "responded");
    assert.equal(store.get(original.id)?.response?.deliveryId, deliveryId);
    assert.equal(dispatches, before);
    assert.equal(recoveries, 2);
    const repeated = await handleAgentThreadRequest(request, { allowedWorkspaces: [directory], endpointDelivery: options });
    assert.equal(repeated.data.status, "delivered");
    assert.equal(repeated.data.action, "send");
    assert.equal(repeated.statusCode, 200);
    assert.equal(recoveries, 2);
    assert.equal(dispatches, before);
    for (const invalid of [
      { ...request, sourceAgentType: undefined },
      { ...request, messageSource: undefined },
      { ...request, messageSource: { ...sourceIdentity, type: "agent" as const, sessionId: "different-owner" } },
      { ...request, messageSource: { ...sourceIdentity, type: "agent" as const, agentAdapter: "dsh" as const } },
      { ...request, sourceThreadId: "unrelated-owner", messageSource: { ...sourceIdentity, type: "agent" as const, sessionId: "unrelated-owner" } }
    ]) await assert.rejects(handleAgentThreadRequest(invalid, { allowedWorkspaces: [directory], endpointDelivery: options }));
    assert.equal(dispatches, before);
    assert.ok(reads.includes(sourceId));
    await assert.rejects(handleAgentThreadRequest({ ...request, deliveryId: "missing-original" }, { allowedWorkspaces: [directory], endpointDelivery: options }), /evidence is unavailable/);
  });
}
