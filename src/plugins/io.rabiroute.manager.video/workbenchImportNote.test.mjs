import assert from "node:assert/strict";
import test from "node:test";
import definition from "./workbench-definition.json" with { type: "json" };
import { importWorkbench } from "./workbenchImport.mjs";

// The source workflow keeps an operator note on almost every node ("prefer the
// PDF over the scrape", "this check must not run twice"). Import used to leave it
// inside `legacy`, where no canvas surface reads it, so the note was effectively
// lost the moment the workflow became a canvas.
const source = name => ({
  name: "note-fixture",
  nodes: [
    { id: "a", name: "建期次目录", kind: "command", cmd: "python", note: "拒绝从 9p/UNC 路径建目录，避免 ACL 变只读。\n第二行不该显示在卡片上。" },
    { id: "b", name: "无说明", kind: "command", cmd: "python" },
    { id: "c", name: "人工格", kind: "manual", note: "人工确认投稿前后的差异。" },
  ],
  edges: [["a", "b"], ["b", "c"]],
  ...(name ? { name } : {}),
});

test("an operator note survives import onto the node config", () => {
  const { canvas } = importWorkbench(source(), definition);
  const byTitle = new Map(canvas.graph.nodes.map(node => [node.title, node]));
  assert.equal(byTitle.get("建期次目录").config.note, "拒绝从 9p/UNC 路径建目录，避免 ACL 变只读。\n第二行不该显示在卡片上。");
});

test("a node without a note gets no empty note field", () => {
  const { canvas } = importWorkbench(source(), definition);
  const plain = canvas.graph.nodes.find(node => node.title === "无说明");
  assert.equal(Object.hasOwn(plain.config, "note"), false);
});

test("a human node keeps its note reachable alongside the instructions field", () => {
  const { canvas } = importWorkbench(source(), definition);
  const human = canvas.graph.nodes.find(node => node.kind === "human");
  assert.equal(human.config.note, "人工确认投稿前后的差异。");
  assert.equal(human.config.instructions, "人工确认投稿前后的差异。");
});

test("a blank or non-string note is not turned into a field", () => {
  const blank = { name: "blank", nodes: [
    { id: "a", name: "空格", kind: "command", cmd: "python", note: "   " },
    { id: "b", name: "数字", kind: "command", cmd: "python", note: 42 },
  ], edges: [["a", "b"]] };
  const { canvas } = importWorkbench(blank, definition);
  for (const node of canvas.graph.nodes) assert.equal(Object.hasOwn(node.config, "note"), false, node.title);
});

test("the note does not change the executable outcome of the node", () => {
  const { canvas } = importWorkbench(source(), definition);
  const node = canvas.graph.nodes.find(row => row.title === "建期次目录");
  // Notes are review context only: the node still needs its tool and argv resolved.
  assert.equal(node.config.unresolved, true);
  assert.equal(node.kind, "command");
});
