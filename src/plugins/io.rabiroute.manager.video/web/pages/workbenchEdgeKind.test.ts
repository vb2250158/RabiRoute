import assert from "node:assert/strict";
import test from "node:test";
import { resolveEdgeKind, workflowArtifactKeys, type FlowNode } from "./workbenchEditor";

const node = (id: string, kind: string, extra: Partial<FlowNode> = {}): FlowNode =>
  ({ id, kind, config: {}, ...extra });

// §1.2 of the canvas brief: the user never picks a port. A drop becomes a
// material edge or a control edge purely from what the source already has.
test("a source that declares artifacts feeds material; a bare source only carries control", () => {
  const produced = node("prepare", "command", { requirements: [{ key: "brief", freshness: "produced" }] });
  const bare = node("gate", "command");
  const target = node("generate", "generate", { requirements: [{ key: "video", freshness: "produced" }] });

  assert.deepEqual(workflowArtifactKeys(produced), ["brief"]);
  assert.equal(resolveEdgeKind({ from: "prepare", to: "generate", sourceNode: produced, targetNode: target }), "input");
  assert.equal(resolveEdgeKind({ from: "gate", to: "generate", sourceNode: bare, targetNode: target }), "step");
});

test("declared artifacts decide the edge, not the node kind", () => {
  // An agent with an artifact carries material even though it is a model node.
  const agentWithOutput = node("write", "agent", { requirements: [{ key: "draft", freshness: "produced" }] });
  const humanWithOutput = node("review", "human", { requirements: [{ key: "verdict", freshness: "validated" }] });
  const target = node("publish", "command");
  assert.equal(resolveEdgeKind({ from: "write", to: "publish", sourceNode: agentWithOutput, targetNode: target }), "input");
  assert.equal(resolveEdgeKind({ from: "review", to: "publish", sourceNode: humanWithOutput, targetNode: target }), "input");
});

test("a text source feeding a media card stays a text link", () => {
  // Text used to have its own port pair; it now travels the single channel but
  // keeps its own stored shape, so media cards still receive it as content.
  assert.equal(resolveEdgeKind({ from: "draft", to: "cover", textSourceIds: ["draft"], mediaIds: ["cover"] }), "content");
  // The same source onto a workflow node is material/control, never content.
  assert.equal(resolveEdgeKind({ from: "draft", to: "write", sourceNode: node("draft", "agent"),
    targetNode: node("write", "agent"), textSourceIds: ["draft"], mediaIds: [] }), "step");
});

test("a drop onto its own card or onto an unknown card creates nothing", () => {
  const source = node("a", "command", { requirements: [{ key: "x", freshness: "produced" }] });
  assert.equal(resolveEdgeKind({ from: "a", to: "a", sourceNode: source, targetNode: source }), undefined);
  assert.equal(resolveEdgeKind({ from: "a", to: "gone", sourceNode: source }), undefined);
  assert.equal(resolveEdgeKind({ from: "gone", to: "a", targetNode: source }), undefined);
});

test("a source without declared artifacts never claims a material edge even when the target has requirements", () => {
  // Regression guard: the old canvas let the user pick the material port and
  // then silently produced nothing, because only the source can supply a key.
  const source = node("empty", "command");
  const target = node("needs", "generate", { requirements: [{ key: "video", freshness: "produced" }] });
  assert.equal(resolveEdgeKind({ from: "empty", to: "needs", sourceNode: source, targetNode: target }), "step");
});
