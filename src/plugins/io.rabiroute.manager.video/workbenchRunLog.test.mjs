import assert from "node:assert/strict";
import test from "node:test";
import { WorkbenchRuns } from "./workbenchRuns.mjs";

// §7.1 of the canvas brief: a command node and a model node used to produce
// identical log lines. Only the wording helpers are exercised here; the run
// itself is covered by workbenchRuns.test.mjs.
const runs = Object.create(WorkbenchRuns.prototype);

const node = (extra) => ({ id: "n1", kind: "command", config: {}, title: "节点", ...extra });
const run = (nodes) => ({ snapshot: { graph: { nodes } } });

test("a command node logs the tool and its argv", () => {
  const line = runs.startLine(node({ title: "环境预检", kind: "command",
    config: { toolKey: "python", argv: ["check.py", "--strict"] } }), run([]));
  assert.equal(line, "▶ 环境预检 执行 python check.py --strict");
});

test("a command with no argv still names the tool", () => {
  assert.equal(runs.startLine(node({ title: "预检", config: { toolKey: "node" } }), run([])), "▶ 预检 执行 node");
  assert.equal(runs.startLine(node({ title: "预检", config: {} }), run([])), "▶ 预检 执行 命令");
});

test("a model node lists its materials and says it calls the model", () => {
  const source = { id: "s1", title: "采集", kind: "command" };
  const line = runs.startLine(node({ title: "写稿", kind: "agent",
    inputs: [{ producerNodeId: "s1", artifactKey: "news.md" }] }), run([source]));
  assert.equal(line, "▶ 写稿 接收 1 份材料：采集(news.md) → 调用模型生成");
});

test("a model node with several materials counts every source", () => {
  const sources = [{ id: "a", title: "A" }, { id: "b", title: "B" }];
  const line = runs.startLine(node({ title: "写稿", kind: "agent",
    inputs: [{ producerNodeId: "a", artifactKey: "x" }, { producerNodeId: "b", artifactKey: "y" }] }), run(sources));
  assert.equal(line, "▶ 写稿 接收 2 份材料：A(x)、B(y) → 调用模型生成");
});

test("a generate node says media generation, not model generation", () => {
  assert.equal(runs.startLine(node({ title: "出图", kind: "generate" }), run([])), "▶ 出图 调用媒体生成");
});

test("a finished node names the artifacts it produced", () => {
  const finish = runs.finishLine(node({ title: "出图", kind: "generate" }),
    { state: "succeeded", artifacts: [{ path: "output/cover.png" }, { key: "meta" }] });
  assert.equal(finish, "✓ 出图 生成完成 → cover.png、meta");
});

test("a finished node with no artifacts falls back to a plain done line", () => {
  assert.equal(runs.finishLine(node({ title: "预检" }), { state: "succeeded", artifacts: [] }), "✓ 预检 完成");
});

test("a failed node reports the failure and its reason", () => {
  assert.equal(runs.finishLine(node({ title: "预检" }), { state: "failed", reason: "退出码 2" }), "✗ 预检 failed：退出码 2");
});

test("the first line states topology scope and the disabled count", () => {
  const line = runs.scopeLine(run([
    { id: "a", title: "A", enabled: true },
    { id: "b", title: "B", enabled: false },
    { id: "c", title: "C", enabled: false },
  ]));
  assert.equal(line, "拓扑序 3 个节点（已禁用跳过 2 个）");
});

test("the scope line lists the nodes that will stop for confirmation", () => {
  const line = runs.scopeLine(run([
    { id: "a", title: "投稿", approval: true },
    { id: "b", title: "定稿", config: { approval: true } },
    { id: "c", title: "采集", config: {} },
  ]));
  assert.equal(line, "拓扑序 3 个节点（已禁用跳过 0 个）；会停下等确认：投稿、定稿");
});
