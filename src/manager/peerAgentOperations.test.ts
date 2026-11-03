import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRequestStore } from "../agentRequests/store.js";
import { executeEndpointAgentDelivery } from "../agentRequests/endpointDelivery.js";
import { agentReplyRequest } from "../agentRequests/replyParameters.js";
import { agentThreadRequestFailureData, type AgentThreadRequest } from "../agentThreads.js";
import { createAgentEndpointDelivery, type AgentEndpointDeliveryContext } from "./agentEndpointDelivery.js";
import { createPeerAgentEndpointBridge, type PeerAgentEndpointBridge, type PeerAgentRequest } from "./peerAgentEndpointBridge.js";
import { createPeerAgentOperations } from "./peerAgentOperations.js";
import { createAgentThreadControlOwner } from "./agentThreadControlRoutes.js";
import { createAgentThreadControlOperations } from "./agentThreadControlOperations.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import type { RabiLinkAgentPrincipal } from "./rabiLinkAgentDevices.js";
import { rabiLinkAgentTaskSource } from "./rabiLinkAgentDeviceConnection.js";

test("registered HTTP prepared operations preserve one intent through lost acceptance, formal reply and caller lookup", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "peer-agent-http-"));
  const principals = new WeakMap<http.IncomingMessage, RabiLinkAgentPrincipal>();
  const scope = () => "fixture-application";
  const stores = new Map<string, AgentRequestStore>();
  const bridges = new Map<string, PeerAgentEndpointBridge>();
  const owners = new Map<string, ReturnType<typeof createAgentEndpointDelivery>>();
  const servers = new Map<string, { base: string; server: http.Server; registration: { dispose(): Promise<void> } }>();
  let bSends = 0, aReplies = 0, loseResponse = true;
  t.after(async () => {
    for (const { server, registration } of servers.values()) { server.closeAllConnections(); await registration.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); }
    for (const store of stores.values()) await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const readLocal = async (_provider: unknown, id: string) => ({ id, title: id, cwd: directory, updatedAt: "" });
  for (const deviceId of ["pc-a", "pc-b"]) {
    const instanceId = `instance-${deviceId}`, store = new AgentRequestStore(path.join(directory, deviceId + ".json"));
    stores.set(deviceId, store); await store.ready();
    const requestResult = async (target: string, method: "GET" | "POST", pathname: string, body?: unknown) => {
      const response = await fetch(servers.get(target)!.base + pathname, { method, headers: { "content-type": "application/json", "x-fixture-source-pc": deviceId },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    const request: PeerAgentRequest = async (target, method, pathname, body) => {
      const result = await requestResult(target, method, pathname, body);
      if (deviceId === "pc-a" && pathname === "/api/agent/prepared-deliveries" && loseResponse && result.status === 200) { loseResponse = false; throw new Error("accepted HTTP response lost"); }
      if (result.status >= 400) throw new Error(JSON.stringify(result.body));
      return result.body;
    };
    const bridge = createPeerAgentEndpointBridge({ managerInstanceId: instanceId, localDeviceId: () => deviceId, scope, store, request, requestResult,
      receiptDirectory: path.join(directory, deviceId + "-receipts"), readLocal,
      localOptions: () => ({ allowedWorkspaces: [directory] }), principal: request => principals.get(request),
      executeOwner: async delivery => { bSends++; return { threadId: delivery.target.sessionId, action: "started", transport: "test-native-owner" }; },
      recoverOwner: async () => undefined });
    bridges.set(deviceId, bridge);
    const owner = createAgentEndpointDelivery({ store, registry: { localInstanceId: instanceId }, authority: {}, config: {},
      receiptDirectory: path.join(directory, deviceId + "-local-receipts"), readLocal, localOptions: () => ({ allowedWorkspaces: [directory] }), peer: bridge } as unknown as AgentEndpointDeliveryContext);
    owners.set(deviceId, owner);
    const endpointOptions = (principal?: RabiLinkAgentPrincipal, authority: () => void = () => {}) => {
      const options = owner.options(undefined, authority, principal);
      return { ...options, dispatch: async (delivery: Parameters<typeof options.dispatch>[0], guard: () => void) => {
        if (bridge.owns(delivery.target)) return options.dispatch(delivery, guard);
        guard(); aReplies++;
        return { deliveryId: delivery.deliveryId, generation: delivery.generation, endpoint: delivery.target, promptHash: delivery.promptHash,
          executionOptionsHash: delivery.executionOptionsHash, accepted: true as const, action: "started", transport: "test-native-reply-owner" };
      } };
    };
    const threadOwner = createAgentThreadControlOwner({ agentRequests: store,
      getTrustedDeviceSource: request => principals.get(request) ?? rabiLinkAgentTaskSource(request, {
        enabled: true, url: "http://fixture.invalid", token: "fixture-application", deviceId
      }, "fixture-generation"),
      messageProcessingBoard: { submitOutcome: () => { throw new Error("Unexpected handoff"); }, recordHandoffReturned: () => { throw new Error("Unexpected handoff"); } },
      applyManagedAgentThreadDefaults: request => request,
      agentThreadRequestOptions: (_request, extra) => ({ allowedWorkspaces: [directory], ...extra }),
      readEndpointDeliveryOptions: (_remote, guard, principal) => endpointOptions(principal, guard),
      handleAgentThreadRequest: async (request, options, principal) => request.action === "read"
        ? { statusCode: 200, data: { code: 0, thread: await readLocal(request.agentAdapter, request.threadId!) } }
        : executeEndpointAgentDelivery(request, endpointOptions(principal, options.requestAuthority)),
      forwardPeerReply: (request, guard) => bridge.forwardReply(request, guard),
      forwardPeerCallerLookup: (callerId, source, guard) => bridge.forwardCallerLookup(callerId, source, guard),
      agentThreadRequestFailureData, setMessageProcessingPlanBaseline: () => {}, refreshAgentRequestReminderTimers: () => {}, publishManagerEvent: () => {},
      operationalLog: { record: () => null }, operationalError: () => undefined });
    const registry = new ManagerPluginRouteRegistry();
    const registration = registry.registerOperations("fixture-peer-agents", [...createPeerAgentOperations(bridge), ...createAgentThreadControlOperations(threadOwner)]);
    const server = http.createServer((request, response) => {
      // Test ingress simulates the already-authenticated transport owner before routing/body parsing.
      const source = request.headers["x-fixture-source-pc"];
      if (typeof source === "string") principals.set(request, { scope: scope(), sourceDeviceId: source, deviceOwner: true });
      markAuthenticatedConnectionRequest(request, () => {});
      if (request.url === "/api/lan-agent/instances") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ code: 0, instances: [{ local: true, instanceId, agents: [] }] })); return; }
      if (!registry.handle(request, new URL(request.url!, "http://fixture.invalid"), response)) response.writeHead(404).end("{}");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    servers.set(deviceId, { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server, registration });
  }
  const call = async (device: string, pathname: string, body?: unknown) => {
    const response = await fetch(servers.get(device)!.base + pathname, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const request: AgentThreadRequest = { action: "send", agentAdapter: "codex", instanceBinding: { ownerDeviceId: "pc-b", instanceId: "instance-pc-b", agentId: "unregistered" },
    sourceThreadId: "source-a", sourceAgentType: "agent", threadId: "target-b", messageSource: { type: "agent", agentAdapter: "codex", sessionId: "source-a", sessionName: "Source A" },
    deliveryId: "http-original", prompt: "Exact target", responsePolicy: "required", responseInstruction: "Return the result" };
  assert.equal((await call("pc-a", "/api/agent/threads", request)).body.status, "delivery_unconfirmed");
  const confirmed = await call("pc-a", "/api/agent/threads", request);
  assert.equal(confirmed.body.status, "delivered"); assert.equal(bSends, 1);
  const delivery = stores.get("pc-a")!.getEndpointDelivery(confirmed.body.delivery.deliveryId)!;
  assert.equal(stores.get("pc-b")!.get(delivery.preparation.requestId!), undefined);
  const reply = { ...agentReplyRequest(delivery.preparation), deliveryId: "http-reply", result: "Done", nextAction: "Review" } as AgentThreadRequest;
  assert.equal((await call("pc-b", "/api/agent/threads", reply)).body.status, "delivered"); assert.equal(aReplies, 1);
  const query = new URLSearchParams({ sourceThreadId: "target-b", sourceAgentType: "agent", agentAdapter: "codex", ledgerOwnerDeviceId: "pc-a", inReplyToRequestId: delivery.preparation.requestId! });
  const lookup = await call("pc-b", "/api/agent/deliveries/caller/http-reply?" + query);
  assert.equal(lookup.status, 200); assert.equal(lookup.body.data.state, "committed"); assert.equal(aReplies, 1); assert.equal(bSends, 1);
  const absent = await call("pc-b", "/api/agent/deliveries/caller/not-reserved?" + query);
  assert.equal(absent.status, 404); assert.equal(absent.body.errorCode, "DELIVERY_NOT_RESERVED");
  assert.equal(absent.body.canSubmitSameIntent, true); assert.equal(aReplies, 1); assert.equal(bSends, 1);
  const spoof = await call("pc-b", "/api/agent/prepared-deliveries", { ledgerOwnerDeviceId: "pc-a", delivery });
  assert.notEqual(spoof.status, 200, "JSON owner address cannot replace transport provenance"); assert.equal(bSends, 1);
});
