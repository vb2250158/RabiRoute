import assert from "node:assert/strict";
import test from "node:test";
import {
  agentEntriesFromInstances, agentSelectionFromConfig, applyAgentSelection, selectedEntryKey, workbenchAgentGroups,
} from "../../src/plugins/io.rabiroute.manager.video/web/pages/workbenchAgentCatalog";

const local = {
  instanceId: "this-pc", local: true, connected: true, agents: [
    { agentId: "dsh-1", name: "DSH 主会话", provider: "dsh", enabled: true, workspace: "C:/work" },
    { agentId: "marvis-1", name: "Marvis", provider: "marvis", enabled: true },
    { agentId: "off-1", name: "停用的 DSH", provider: "dsh", enabled: false },
  ],
};
const remote = {
  instanceId: "other-pc", ownerDeviceId: "device-2", name: "书房电脑", local: false, connected: true,
  agents: [{ agentId: "codex-1", name: "Codex", provider: "codex", enabled: true }],
};
const offline = { instanceId: "offline-pc", local: false, connected: false, agents: [{ agentId: "dsh-2", name: "DSH", provider: "dsh", enabled: true }] };
const disabled = { instanceId: "disabled-pc", local: false, connected: true, enabled: false, agents: [{ agentId: "dsh-3", name: "DSH", provider: "dsh", enabled: true }] };

test("only connected, enabled, thread-capable Agents become node targets", () => {
  const entries = agentEntriesFromInstances([local, remote, offline, disabled]);
  assert.deepEqual(entries.map(entry => entry.key), ["session:local:this-pc:dsh-1", "session:device-2:other-pc:codex-1"]);
  const [own, other] = entries;
  assert.equal(own.group, "local");
  assert.equal(own.detail, "C:/work");
  assert.deepEqual(own.binding, { instanceId: "this-pc", agentId: "dsh-1" });
  assert.equal(other.group, "remote");
  assert.equal(other.detail, "书房电脑");
  assert.deepEqual(other.binding, { instanceId: "other-pc", agentId: "codex-1", ownerDeviceId: "device-2" });
});

test("groups keep CLI, this computer and other computers in that order and drop empty ones", () => {
  const entries = [
    { key: "cli:codex", group: "cli", kind: "cli", provider: "codex", label: "Codex CLI" },
    { key: "session:device-2:other-pc:codex-1", group: "remote", kind: "session", provider: "codex", label: "Codex" },
  ] as any;
  assert.deepEqual(workbenchAgentGroups(entries).map((group: any) => [group.group, group.entries.length]), [["cli", 1], ["remote", 1]]);
  assert.deepEqual(workbenchAgentGroups([]), []);
});

test("switching target kind removes the other execution owner", () => {
  const withSession = applyAgentSelection({ textPrompt: "hi", target: { agentAdapter: "dsh", threadId: "old" } }, { kind: "cli", provider: "codex", model: "gpt-5" });
  assert.deepEqual(withSession.cli, { provider: "codex", model: "gpt-5" });
  assert.equal(withSession.target, undefined);
  assert.equal(withSession.textPrompt, "hi");

  const withCli = applyAgentSelection({ textPrompt: "hi", cli: { provider: "codex" } }, {
    kind: "session", provider: "dsh", threadId: "thread-9", instanceBinding: { instanceId: "other-pc", agentId: "dsh-1", ownerDeviceId: "device-2" }, cwd: "C:/work", deviceName: "书房电脑",
  });
  assert.equal(withCli.cli, undefined);
  assert.deepEqual(withCli.target, {
    agentAdapter: "dsh", threadId: "thread-9", instanceBinding: { instanceId: "other-pc", agentId: "dsh-1", ownerDeviceId: "device-2" }, cwd: "C:/work", deviceName: "书房电脑",
  });
});

test("clearing the selection removes both owners", () => {
  assert.deepEqual(applyAgentSelection({ cli: { provider: "codex" }, target: { agentAdapter: "dsh", threadId: "x" }, textPrompt: "keep" }, undefined), { textPrompt: "keep" });
});

test("a saved node reads back exactly the target it selected", () => {
  const selection = { kind: "session" as const, provider: "codex", threadId: "thread-2", instanceBinding: { instanceId: "other-pc", agentId: "codex-1", ownerDeviceId: "device-2" }, cwd: "D:/work", deviceName: "书房电脑" };
  const config = applyAgentSelection({}, selection);
  assert.deepEqual(agentSelectionFromConfig(config), selection);
  assert.deepEqual(agentSelectionFromConfig(applyAgentSelection({}, { kind: "cli", provider: "workbuddy", model: "custom" })), { kind: "cli", provider: "workbuddy", model: "custom" });
});

test("a session without an exact thread is not a runnable target", () => {
  assert.equal(agentSelectionFromConfig({ target: { agentAdapter: "dsh" } }), undefined);
  assert.equal(agentSelectionFromConfig({ agentBindingKey: "reviewer" }), undefined);
  assert.equal(agentSelectionFromConfig(undefined), undefined);
});

test("the saved target matches its catalogue row and survives a missing row", () => {
  const entries = agentEntriesFromInstances([remote]);
  assert.equal(selectedEntryKey(entries, { kind: "session", provider: "codex", threadId: "t", instanceBinding: { instanceId: "other-pc", agentId: "codex-1", ownerDeviceId: "device-2" } }), entries[0].key);
  assert.equal(selectedEntryKey([], { kind: "session", provider: "dsh", threadId: "t" }), "session:unknown:dsh");
  assert.equal(selectedEntryKey(entries, { kind: "cli", provider: "codex" }), "cli:codex");
  assert.equal(selectedEntryKey(entries, undefined), "");
});
