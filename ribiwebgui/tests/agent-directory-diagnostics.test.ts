import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { baseParse, NodeTypes, type ElementNode, type TemplateChildNode } from "@vue/compiler-dom";
import { parse } from "@vue/compiler-sfc";
import { agentDirectoryDiagnosticsForTarget, agentDirectoryFailure, readAgentInstanceDirectory, readConnectedAgentInstances, unassignedAgentDirectoryDiagnostics, type AgentDirectoryDiagnostic } from "../src/connectedAgentInstances";
import type { GatewayDefinition } from "../src/types";

const response = (body: unknown, status = 200) => Response.json(body, { status });
const manifest = { type: "codex", label: "Codex", capabilities: { managedTasks: { agentThreads: true } } };

test("unconfigured device and failed Peer discovery preserve the three local cards, route binding and successful hosts", async () => {
  const route: GatewayDefinition = { id: "demo", gatewayPort: 0, agentAdapters: ["codex", "dsh", "copilotCli"],
    primaryAgentTarget: "local:dsh", primaryAgentAdapter: "dsh", dshSessionId: "original-task", dshCwd: "D:/Original", remoteAgentTargets: [] };
  const before = structuredClone(route);
  const calls: string[] = [];
  const directory = await readAgentInstanceDirectory(async input => {
    const url = String(input); calls.push(url);
    if (url === "/api/lan-agent/instances") return response({ code: 0, instances: [{ instanceId: "connector", local: false, connected: true, agents: [] }] });
    if (url === "/api/device-agents") return response({ code: -1, message: "DEVICE_AGENT_CONTEXT_UNAVAILABLE" }, 503);
    if (url === "/meta") return response({ rabiLinkRelay: { deviceId: "self" } });
    if (url === "/api/rabilink/peer/list") return response({ peers: [
      { id: "pc-a", online: true, deviceKind: "pc" }, { id: "pc-b", online: true, deviceKind: "pc" }
    ] });
    if (url.endsWith("/api/agent-adapters/catalog")) return response({ code: 0, data: { adapters: [manifest] } });
    if (url.includes("pc-a")) return response({ code: -1, message: "Peer call failed; check target, access and connectivity." }, 503);
    return response({ code: 0, instances: [{ instanceId: "instance-b", local: true, connected: true, agents: [] }] });
  }, {});
  assert.deepEqual(directory.instances.map(item => [item.instanceId, item.ownerDeviceId]), [["connector", undefined], ["instance-b", "pc-b"]]);
  assert.deepEqual(directory.diagnostics, [
    { source: "device-agents", message: "DEVICE_AGENT_CONTEXT_UNAVAILABLE" },
    { source: "peer-instances", ownerDeviceId: "pc-a", message: "Peer call failed; check target, access and connectivity." }
  ]);
  assert.deepEqual(unassignedAgentDirectoryDiagnostics(directory.diagnostics, route.remoteAgentTargets!), directory.diagnostics,
    "unconfigured-source errors remain available in Add Agent discovery, without creating a local-card/global alert");
  assert.deepEqual(route, before, "discovery never changes saved sessions, primary selection or Route targets");
  assert.equal(calls.length, new Set(calls).size, "one discovery pass makes one request per source, without replay");
});

test("configured device and Peer cards receive only their own directory diagnostics, even with equal instance IDs", () => {
  const device = { provider: "deviceAgent", instanceId: "shared", agentId: "device" };
  const peerA = { provider: "codex", instanceId: "shared", agentId: "local:codex", ownerDeviceId: "pc-a" };
  const peerB = { ...peerA, ownerDeviceId: "pc-b" };
  const diagnostics: AgentDirectoryDiagnostic[] = [
    { source: "device-agents", message: "device not ready" },
    { source: "peer-instances", ownerDeviceId: "pc-a", message: "pc-a unreachable" },
    { source: "peer-adapters", ownerDeviceId: "pc-a", message: "pc-a metadata unavailable" },
    { source: "peer-instances", ownerDeviceId: "pc-c", message: "unconfigured pc-c failed" }
  ];
  assert.deepEqual(agentDirectoryDiagnosticsForTarget(diagnostics, device), [diagnostics[0]]);
  assert.deepEqual(agentDirectoryDiagnosticsForTarget(diagnostics, peerA), [diagnostics[1], diagnostics[2]]);
  assert.deepEqual(agentDirectoryDiagnosticsForTarget(diagnostics, peerB), []);
  assert.deepEqual(unassignedAgentDirectoryDiagnostics(diagnostics, [device, peerA, peerB]), [diagnostics[3]]);
});

test("an unavailable Peer capability catalog preserves its real instance and its saved Agent while reporting that owner", async () => {
  const directory = await readConnectedAgentInstances(async input => {
    const url = String(input);
    if (url === "/meta") return response({ rabiLinkRelay: { deviceId: "self" } });
    if (url === "/api/rabilink/peer/list") return response({ peers: [{ id: "pc-a", online: true, deviceKind: "pc" }] });
    if (url.endsWith("/api/agent-adapters/catalog")) return response({ code: -1, message: "capabilities unavailable" }, 503);
    return response({ code: 0, instances: [{ instanceId: "original-instance", local: true, connected: true,
      agents: [{ agentId: "saved-agent", provider: "dsh", enabled: true, sessionId: "original-session" }] }] });
  }, {});
  assert.equal(directory.instances[0]?.ownerDeviceId, "pc-a");
  assert.equal(directory.instances[0]?.agents[0]?.sessionId, "original-session");
  assert.deepEqual(directory.diagnostics, [{ source: "peer-adapters", ownerDeviceId: "pc-a", message: "capabilities unavailable" }]);
});

test("Peer directory failure does not erase independent local and device discovery results", async () => {
  const directory = await readAgentInstanceDirectory(async input => {
    const url = String(input);
    if (url === "/api/lan-agent/instances") return response({ code: 0, instances: [{ instanceId: "connector", agents: [] }] });
    if (url === "/api/device-agents") return response({ code: 0, data: { ownerInstanceId: "device-owner", agents: [{ agentId: "device:stable", provider: "deviceAgent", enabled: true }] } });
    if (url === "/meta") return response({ rabiLinkRelay: { deviceId: "self" } });
    assert.equal(url, "/api/rabilink/peer/list");
    return response({ code: -1, message: "peer directory unavailable" }, 503);
  }, {});
  assert.deepEqual(directory.instances.map(instance => instance.instanceId), ["connector", "device-owner"]);
  assert.deepEqual(directory.diagnostics, [{ source: "peer-directory", message: "peer directory unavailable" }]);
  const access = agentDirectoryFailure("access", new Error("directory access unavailable"));
  assert.deepEqual(unassignedAgentDirectoryDiagnostics([access], []), [access]);
});

test("all page-owned directory reads receive the same cancellation signal and cancelled lanes do not schedule Peer requests", async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  const pending = readAgentInstanceDirectory((input, init) => {
    calls.push(String(input));
    assert.equal(init?.signal, controller.signal);
    return new Promise((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }));
  }, {}, controller.signal);
  controller.abort();
  const directory = await pending;
  assert.deepEqual(calls.sort(), ["/api/device-agents", "/api/lan-agent/instances", "/api/rabilink/peer/list", "/meta"].sort());
  assert.equal(directory.instances.length, 0);
  assert.ok(directory.diagnostics.length, "cancelled reads settle for their original page owner; they are not retried");
});

test("Route diagnostic presentation stays in target cards or the accessible Add Agent discovery menu", () => {
  const { descriptor } = parse(fs.readFileSync(new URL("../../src/plugins/io.rabiroute.manager.message-adapter-control/web/pages/RouteConfigPage.vue", import.meta.url), "utf8"));
  const root = baseParse(descriptor.template!.content);
  const elements: Array<{ node: ElementNode; ancestors: ElementNode[] }> = [];
  function walk(children: TemplateChildNode[], ancestors: ElementNode[] = []) {
    for (const node of children) if (node.type === NodeTypes.ELEMENT) {
      elements.push({ node, ancestors }); walk(node.children, [...ancestors, node]);
    }
  }
  walk(root.children);
  const directive = (node: ElementNode, name: string) => node.props.find(prop => prop.type === NodeTypes.DIRECTIVE && prop.name === name);
  const expression = (node: ElementNode, name: string) => {
    const prop = directive(node, name); return prop?.type === NodeTypes.DIRECTIVE ? prop.exp?.loc.source : undefined;
  };
  const alerts = elements.filter(({ node }) => node.tag === "v-alert" && expression(node, "for")?.includes("diagnostic"));
  assert.equal(alerts.length, 2);
  assert.ok(alerts.some(({ node, ancestors }) => expression(node, "for")?.includes("target.diagnostics")
    && ancestors.some(parent => expression(parent, "for") === "target in remoteAgentItems")));
  assert.ok(alerts.some(({ node, ancestors }) => expression(node, "for")?.includes("agentDiscoveryDiagnostics")
    && ancestors.some(parent => parent.tag === "details") && ancestors.some(parent => parent.tag === "v-menu")));
  assert.equal(elements.filter(({ node }) => node.tag === "v-alert" && expression(node, "if") === "lanAgentError").length, 0);
  const addButton = elements.find(({ node }) => node.tag === "v-btn" && node.props.some(prop => prop.type === NodeTypes.DIRECTIVE
    && prop.name === "bind" && prop.arg?.loc.source === "aria-label" && prop.exp?.loc.source === "translateText('添加 Agent')"));
  assert.ok(addButton, "Add Agent has a stable accessible name even when no instances can be added");
  assert.equal(addButton.node.props.some(prop => prop.type === NodeTypes.ATTRIBUTE ? prop.name === "disabled"
    : prop.type === NodeTypes.DIRECTIVE && prop.arg?.loc.source === "disabled"), false);
  const interactive = new Set(["button", "v-btn", "summary"]);
  for (const { node, ancestors } of elements) if (interactive.has(node.tag)) {
    assert.ok(!ancestors.some(parent => interactive.has(parent.tag)), `${node.tag} must not nest in another interactive control`);
  }
  assert.ok(elements.some(({ node }) => node.tag === "v-alert" && expression(node, "if") === "agentScanErrors[agent.type]"),
    "original per-Agent scan failure presentation remains inside the existing local card");
});
