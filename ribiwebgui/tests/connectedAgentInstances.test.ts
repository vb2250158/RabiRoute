import test from "node:test";
import assert from "node:assert/strict";
import { readConnectedAgentInstances } from "../src/connectedAgentInstances";

test("connected host catalogs preserve the owning PC and isolate one unavailable host", async () => {
  const read = async (input: RequestInfo | URL) => {
    const pathname = String(input);
    const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (pathname === "/meta") return response({ rabiLinkRelay: { deviceId: "pc-a" } });
    if (pathname === "/api/rabilink/peer/list") return response({ peers: [
      { id: "pc-a", online: true, deviceKind: "pc" }, { id: "pc-b", online: true, deviceKind: "pc" },
      { id: "pc-c", online: true, deviceKind: "pc" }, { id: "phone", online: true, deviceKind: "phone" }
    ] });
    if (pathname.includes("pc-c")) return response({ code: -1, message: "host unavailable" }, 503);
    if (pathname.endsWith("/api/agent-adapters/catalog")) return response({ code: 0, data: { adapters: [
      { type: "codex", label: "Codex Desktop", capabilities: { managedTasks: { agentThreads: true } } }
    ] } });
    assert.equal(pathname, "/api/rabilink/peer/http/pc-b/manager/api/lan-agent/instances");
    return response({ code: 0, instances: [{ instanceId: "instance-b", local: true, connected: true, agents: [] },
      { instanceId: "child-connector", local: false, connected: true, agents: [] }] });
  };
  const result = await readConnectedAgentInstances(read as typeof fetch, {});
  assert.equal(result.instances.length, 1);
  assert.equal(result.instances[0]?.ownerDeviceId, "pc-b");
  assert.equal(result.instances[0]?.instanceId, "instance-b");
  assert.equal(result.instances[0]?.local, false);
  assert.deepEqual(result.instances[0]?.agents, [{ agentId: "local:codex", name: "Codex Desktop", provider: "codex", enabled: true }], "an empty Route catalog must not require Agent registration before querying its real native sessions");
  assert.match(result.errors[0]!, /pc-c.*host unavailable/);
});
