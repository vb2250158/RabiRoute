import assert from "node:assert/strict";
import test from "node:test";
import {
  agentEntriesFromInstances, agentSelectionFromConfig, applyAgentSelection, loadWorkbenchAgentCatalog, selectedEntryKey,
  workbenchAgentCatalog, workbenchAgentGroups, type WorkbenchAgentEntry,
} from "./workbenchAgentCatalog";
import type { AgentInstance } from "@shared/agentInstance";

// One Agent instance is either the current Manager (local) or a RabiLink peer
// (ownerDeviceId). The canvas Agent picker must never mix those two owners.
const localInstance: AgentInstance = {
  instanceId: "instance-local", local: true, connected: true, hostname: "Elysia", agents: [
    { agentId: "codex:work", name: "工作台 Codex", provider: "codex", enabled: true, workspace: "G:/DigitalLife/RabiRoute" },
    { agentId: "dsh:disabled", name: "停用的 DSH", provider: "dsh", enabled: false },
    { agentId: "marvis:no-threads", name: "不可寻址会话", provider: "marvis", enabled: true },
  ],
};

const remoteInstance: AgentInstance = {
  instanceId: "instance-remote", ownerDeviceId: "pc-b", name: "书房电脑", local: false, connected: true,
  agents: [{ agentId: "dsh:main", name: "书房 DSH", provider: "dsh", enabled: true }],
};

const cliEntry: WorkbenchAgentEntry = { key: "cli:codex", group: "cli", kind: "cli", provider: "codex", label: "Codex CLI", models: [] };
const localEntry: WorkbenchAgentEntry = { key: "session:local:instance-local:codex:work", group: "local", kind: "session", provider: "codex",
  label: "工作台 Codex", binding: { instanceId: "instance-local", agentId: "codex:work" } };
const remoteEntry: WorkbenchAgentEntry = { key: "session:pc-b:instance-remote:dsh:main", group: "remote", kind: "session", provider: "dsh",
  label: "书房 DSH", deviceName: "书房电脑", binding: { instanceId: "instance-remote", agentId: "dsh:main", ownerDeviceId: "pc-b" } };

test("connected instances become selectable sessions; only the owning side decides local versus remote", () => {
  const entries = agentEntriesFromInstances([localInstance, remoteInstance]);
  assert.deepEqual(entries.map(entry => [entry.group, entry.provider, entry.label]), [
    ["local", "codex", "工作台 Codex"],
    ["remote", "dsh", "书房 DSH"],
  ]);
  const [local, remote] = entries;
  assert.equal(local.key, "session:local:instance-local:codex:work");
  assert.deepEqual(local.binding, { instanceId: "instance-local", agentId: "codex:work" });
  assert.equal(local.detail, "G:/DigitalLife/RabiRoute");
  assert.equal(local.sessionId, undefined);
  assert.equal(remote.key, "session:pc-b:instance-remote:dsh:main");
  assert.deepEqual(remote.binding, { instanceId: "instance-remote", agentId: "dsh:main", ownerDeviceId: "pc-b" });
  assert.equal(remote.detail, "书房电脑");
  assert.equal(remote.deviceName, "书房电脑");
  assert.equal(remote.workspace, undefined);
  // A disabled Agent, an adapter without the thread surface and a disconnected
  // host stay out of the picker instead of producing an unusable target.
  assert.deepEqual(agentEntriesFromInstances([
    { ...localInstance, connected: false },
    { ...localInstance, enabled: false },
    { ...localInstance, agents: [{ agentId: "marvis:no-threads", name: "不可寻址会话", provider: "marvis", enabled: true }] },
  ]), []);
});

test("the picker keeps the three owner groups in CLI, local, remote order and hides empty ones", () => {
  assert.deepEqual(workbenchAgentGroups([remoteEntry, localEntry, cliEntry]).map(group => [group.group, group.label, group.entries.map(entry => entry.key)]), [
    ["cli", "本机 CLI", ["cli:codex"]],
    ["local", "本机已接入 Agent", [localEntry.key]],
    ["remote", "其他电脑", [remoteEntry.key]],
  ]);
  assert.deepEqual(workbenchAgentGroups([remoteEntry]).map(group => group.group), ["remote"]);
  assert.deepEqual(workbenchAgentGroups([]), []);
});

test("a CLI row declares its own install and readiness while the catalogue keeps every source's failure separate", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  const provider = (id: string, label: string, installed: boolean, ready: boolean) => ({ id, label, installUrl: `https://example.invalid/${id}`, installed, ready, models: [{ id: "auto", label: "auto" }] });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    requests.push(url);
    const body = url.startsWith("/api/video/v2/cli") ? { providers: [provider("codex", "Codex CLI", false, false), provider("dsh", "DSH CLI", true, false), provider("workbuddy", "WorkBuddy CLI", true, true)] }
      : url.startsWith("/api/webgui-access") ? { code: 0, data: { token: "webgui-token" } }
        : url.startsWith("/api/lan-agent/instances") ? { code: 0, instances: [localInstance, remoteInstance] }
          : url.startsWith("/api/device-agents") ? { code: 0, data: null }
            : url.startsWith("/api/rabilink/peer/list") ? { peers: [] }
              : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await loadWorkbenchAgentCatalog(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const catalog = workbenchAgentCatalog.value;
  assert.equal(catalog.error, "");
  const cliRows = catalog.entries.filter(entry => entry.group === "cli");
  assert.deepEqual(cliRows.map(entry => [entry.provider, entry.label, entry.disabled, entry.models?.length]), [
    ["codex", "Codex CLI（未安装）", true, 1],
    ["dsh", "DSH CLI（需检查）", true, 1],
    ["workbuddy", "WorkBuddy CLI", false, 1],
  ]);
  // The CLI probe, the access token and the instance directory are the exact
  // reads this row set came from; sessions from both owners stay selectable.
  assert.ok(requests.some(url => url.startsWith("/api/video/v2/cli?refresh=1")));
  assert.ok(requests.some(url => url.startsWith("/api/webgui-access")));
  assert.ok(requests.some(url => url.startsWith("/api/lan-agent/instances")));
  assert.deepEqual(workbenchAgentGroups(catalog.entries).map(group => group.group), ["cli", "local", "remote"]);
});

test("a saved node maps back to its catalogue row and keeps an unknown target visible", () => {
  const entries = [cliEntry, localEntry, remoteEntry];
  assert.equal(selectedEntryKey(entries, { kind: "cli", provider: "codex" }), "cli:codex");
  assert.equal(selectedEntryKey(entries, { kind: "session", provider: "codex", threadId: "thread-1",
    instanceBinding: { instanceId: "instance-local", agentId: "codex:work" } }), localEntry.key);
  assert.equal(selectedEntryKey(entries, { kind: "session", provider: "dsh", threadId: "thread-2",
    instanceBinding: { instanceId: "instance-remote", agentId: "dsh:main", ownerDeviceId: "pc-b" } }), remoteEntry.key);
  assert.equal(selectedEntryKey(entries, { kind: "session", provider: "dsh", threadId: "gone",
    instanceBinding: { instanceId: "instance-missing", agentId: "dsh:missing" } }), "session:unknown:dsh");
  // A legacy node carries a thread id but no binding: it stays selectable by
  // provider. The first same-provider row wins, so the picker may display one
  // computer's row for an older node; the saved target is never rewritten by
  // this lookup alone (see applyAgentSelection, which writes the chosen row).
  assert.equal(selectedEntryKey(entries, { kind: "session", provider: "dsh", threadId: "gone" }), remoteEntry.key);
  assert.equal(selectedEntryKey(entries, { kind: "session", provider: "astrbot", threadId: "gone" }), "session:unknown:astrbot");
  assert.equal(selectedEntryKey(entries, undefined), "");
});

test("switching the target kind removes the other owner's fields so a node never claims two executors", () => {
  const nodeConfig = { title: "Agent 1", target: { agentAdapter: "codex", threadId: "thread-1", cwd: "G:/repo", agentName: "工作台 Codex" } };
  const cli = applyAgentSelection(nodeConfig, { kind: "cli", provider: "workbuddy", model: "auto" });
  assert.deepEqual(cli, { title: "Agent 1", cli: { provider: "workbuddy", model: "auto" } });
  assert.equal(Object.hasOwn(cli, "target"), false);
  const session = applyAgentSelection(cli, { kind: "session", provider: "dsh", threadId: "thread-9",
    instanceBinding: { instanceId: "instance-remote", agentId: "dsh:main", ownerDeviceId: "pc-b" }, cwd: "G:/repo", deviceName: "书房电脑", agentName: "书房 DSH" });
  assert.deepEqual(session, { title: "Agent 1", target: { agentAdapter: "dsh", threadId: "thread-9",
    instanceBinding: { instanceId: "instance-remote", agentId: "dsh:main", ownerDeviceId: "pc-b" }, cwd: "G:/repo", deviceName: "书房电脑", agentName: "书房 DSH" } });
  assert.equal(Object.hasOwn(session, "cli"), false);
  assert.deepEqual(applyAgentSelection(session, undefined), { title: "Agent 1" });
  // Selection is derived from the frozen target only when the exact session id
  // is present; a half-written target stays unselected rather than guessing.
  assert.deepEqual(agentSelectionFromConfig(session), { kind: "session", provider: "dsh", threadId: "thread-9",
    instanceBinding: { instanceId: "instance-remote", agentId: "dsh:main", ownerDeviceId: "pc-b" }, cwd: "G:/repo", deviceName: "书房电脑", agentName: "书房 DSH" });
  assert.deepEqual(agentSelectionFromConfig({ cli: { provider: "codex", model: "auto" } }), { kind: "cli", provider: "codex", model: "auto" });
  assert.equal(agentSelectionFromConfig({ target: { agentAdapter: "codex" } }), undefined);
  assert.equal(agentSelectionFromConfig(undefined), undefined);
});
