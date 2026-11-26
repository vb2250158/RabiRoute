import assert from "node:assert/strict";
import test from "node:test";
import { draftBanner, graphDiff, runThreadBindings, verifyArtifactHashes } from "./workbenchRunRecord";
import type { FlowNode } from "./workbenchEditor";

const node = (id: string, extra: Partial<FlowNode> = {}): FlowNode => ({ id, kind: "command", config: {}, ...extra });
const graph = (nodes: FlowNode[]) => ({ nodes, edges: [], groups: [] });

test("a run reports the exact sessions its frozen graph targeted", () => {
  const rows = runThreadBindings(graph([
    node("a", { title: "写稿", config: { target: { agentAdapter: "codex", threadId: "t-1" } } }),
    node("b", { title: "校验", config: { target: { agentAdapter: "dsh", threadId: "t-2", instanceBinding: { instanceId: "i" } } } }),
    node("c", { title: "命令", config: { toolKey: "node" } }),
    node("d", { title: "半截", config: { target: { agentAdapter: "codex" } } }),
  ]));
  assert.deepEqual(rows.map(row => [row.nodeId, row.agentAdapter, row.threadId]), [
    ["a", "codex", "t-1"], ["b", "dsh", "t-2"],
  ]);
  assert.deepEqual(rows[1]!.instanceBinding, { instanceId: "i" });
});

test("a run with no frozen graph reports no sessions instead of throwing", () => {
  assert.deepEqual(runThreadBindings(undefined), []);
});

test("the graph diff names added, removed and modified nodes with the fields that changed", () => {
  const before = graph([
    node("keep", { title: "不变" }),
    node("edit", { title: "改前", config: { toolKey: "node" } }),
    node("gone", { title: "被删" }),
  ]);
  const after = graph([
    node("keep", { title: "不变" }),
    node("edit", { title: "改后", config: { toolKey: "python" } }),
    node("new", { title: "新增" }),
  ]);
  const changes = graphDiff(before, after);
  assert.deepEqual(changes.map(row => [row.id, row.change]), [["edit", "modified"], ["new", "added"], ["gone", "removed"]]);
  assert.deepEqual(changes[0]!.fields?.sort(), ["config", "title"]);
});

test("an unchanged graph produces no diff", () => {
  const same = graph([node("a", { title: "A" }), node("b", { title: "B" })]);
  assert.deepEqual(graphDiff(same, same), []);
});

test("toggling enabled or approval counts as a modification worth reviewing", () => {
  const changes = graphDiff(graph([node("a", { enabled: true })]), graph([node("a", { enabled: false, approval: true })]));
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0]!.fields?.sort(), ["approval", "enabled"]);
});

test("artifact verification passes only when every recorded hash still matches", () => {
  const result = verifyArtifactHashes(
    [{ path: "out/a.txt", sha256: "aa" }, { path: "out/b.md", sha256: "bb" }],
    [{ path: "out/a.txt", sha256: "aa" }, { path: "out/b.md", sha256: "bb" }]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.checks.map(row => row.state), ["ok", "ok"]);
});

test("a changed file is reported as a mismatch with both hashes", () => {
  const result = verifyArtifactHashes([{ path: "out/a.txt", sha256: "aa" }], [{ path: "out/a.txt", sha256: "zz" }]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.checks[0], { path: "out/a.txt", expected: "aa", actual: "zz", state: "mismatch" });
});

test("a missing file is not silently treated as unchanged", () => {
  const result = verifyArtifactHashes([{ path: "out/a.txt", sha256: "aa" }], []);
  assert.equal(result.ok, false);
  assert.equal(result.checks[0]!.state, "missing");
});

test("a file the run never recorded is surfaced as an unexpected writer", () => {
  const result = verifyArtifactHashes([{ path: "out/a.txt", sha256: "aa" }],
    [{ path: "out/a.txt", sha256: "aa" }, { path: "out/stray.txt", sha256: "cc" }]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.checks[1], { path: "out/stray.txt", actual: "cc", state: "unrecorded" });
});

test("a recorded file without a hash cannot vouch for the directory", () => {
  const result = verifyArtifactHashes([{ path: "out/a.txt" }], [{ path: "out/a.txt", sha256: "aa" }]);
  assert.equal(result.ok, false);
  assert.equal(result.checks[0]!.state, "unrecorded");
});

test("a clean canvas shows no banner at all", () => {
  assert.equal(draftBanner({ dirty: false, conflict: false }), undefined);
});

test("a dirty canvas shows one line with the three actions", () => {
  const banner = draftBanner({ dirty: true, conflict: false });
  assert.equal(banner?.kind, "draft");
  assert.deepEqual(banner?.actions.map(row => row.id), ["restore", "diff", "discard"]);
});

test("a conflict wins over a plain draft and offers recovery", () => {
  const banner = draftBanner({ dirty: true, conflict: true });
  assert.equal(banner?.kind, "conflict");
  assert.match(banner!.text, /已被其他端更新/);
  assert.deepEqual(banner?.actions.map(row => row.id), ["restore", "diff", "discard"]);
});
