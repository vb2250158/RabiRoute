import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";
import { useVideoCanvas } from "./useVideoCanvas";
import { canvasGraphThumbnail, connectWorkflowInput, rebaseWorkflowInputs, workflowInputLinks, workflowRunArtifacts, type FlowNode } from "./workbenchEditor";

test("validated files stay with the selected node and exact run", () => {
  const scope = { projectId: "project", canvasId: "canvas", runId: "run-2", nodeId: "review" };
  const run = {
    id: scope.runId, projectId: scope.projectId, canvasId: scope.canvasId,
    attempts: {
      prepare: { nodeId: "prepare", artifacts: [{ artifactId: "source", key: "checklist", path: "checklist.json" }] },
      review: { nodeId: "review", artifacts: [{ artifactId: "report", key: "warnings", path: "reports/警告（审稿前）.md" }] }
    }
  };
  assert.deepEqual(workflowRunArtifacts(run, scope), [{
    id: "report", name: "警告（审稿前）.md", path: "reports/警告（审稿前）.md", href: "/api/video/v2/runs/run-2/artifacts?artifact=report"
  }]);
  assert.deepEqual(workflowRunArtifacts(run, { ...scope, runId: "run-1" }), []);
  assert.deepEqual(workflowRunArtifacts(run, { ...scope, canvasId: "other" }), []);
  assert.deepEqual(workflowRunArtifacts(run, { ...scope, nodeId: "never-ran" }), []);
});

type CardRect = { id: string; left: number; top: number; width: number; height: number };
test("the viewport limits mounted cards while retaining the selected editor", async () => {
  const canvas = await fixture();
  canvas.positions.value = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`node-${index}`, { x: index * 500, y: 0 }]));
  canvas.selectedIds.value = ["node-900"];
  assert.deepEqual([...canvas.visibleCardIds.value], ["node-0", "node-1", "node-2", "node-900"]);
  canvas.offset.value = { x: -50000, y: 0 };
  assert.ok(canvas.visibleCardIds.value.has("node-100"));
  assert.ok(canvas.visibleCardIds.value.has("node-900"));
  assert.equal(canvas.visibleCardIds.value.has("node-0"), false);
  assert.equal(canvas.positions.value["node-0"]?.x, 0);
});

async function fixture(cards: CardRect[] = [], offset = { left: 0, top: 0 }) {
  let canvas!: ReturnType<typeof useVideoCanvas>;
  await renderToString(createSSRApp({ setup() { canvas = useVideoCanvas(); return () => null; } }));
  let capture: number | undefined;
  canvas.viewport.value = {
    clientWidth: 1200, clientHeight: 900,
    getBoundingClientRect() { return offset; },
    querySelectorAll() {
      return cards.map(({ id, left, top, width, height }) => ({
        dataset: { canvasNode: id },
        querySelector: () => ({
          getBoundingClientRect: () => ({ left, top, width, height, right: left + width, bottom: top + height }),
        }),
      }));
    },
    setPointerCapture(id: number) { capture = id; },
    hasPointerCapture(id: number) { return capture === id; },
    releasePointerCapture() { capture = undefined; },
  } as unknown as HTMLElement;
  return canvas;
}
test("the canvas exposes its mounted viewport size independently of pan and zoom", async () => {
  const canvas = await fixture();
  const viewport = canvas.viewport.value!;
  Object.defineProperties(viewport, {
    clientWidth: { value: 380 },
    clientHeight: { value: 220 },
  });
  canvas.add("text");
  canvas.fit();
  assert.deepEqual(canvas.viewportSize.value, { x: 380, y: 220 });
  canvas.offset.value = { x: -200, y: 340 };
  canvas.zoom(1.6);
  assert.deepEqual(canvas.viewportSize.value, { x: 380, y: 220 });
  assert.ok(canvas.minimap.value.view.width > 0);
});

function pointer(x: number, y: number, id = 1) {
  return { clientX: x, clientY: y, pointerId: id, button: 0, preventDefault() {} } as PointerEvent;
}
test("resizing tracks world size at zoom, keeps it during drag and restores it on cancel", async () => {
  const canvas = await fixture();
  canvas.add("text");
  canvas.scale.value = 0.5;
  const handle = (width: number, height: number) => ({
    ...pointer(100, 100), currentTarget: { closest: () => ({ querySelector: () => ({ offsetWidth: width, offsetHeight: height }) }) }
  }) as unknown as PointerEvent;
  canvas.beginResize(handle(380, 214), "text");
  canvas.move(pointer(160, 130));
  assert.equal(canvas.end(pointer(160, 130)), true);
  assert.deepEqual(canvas.positions.value.text, { x: 0, y: 0, width: 500, height: 274 });
  const map = canvas.minimap.value;
  assert.equal(map.cards[0]?.width, 500 * map.factor);
  canvas.beginResize(handle(500, 274), "text");
  canvas.move(pointer(120, 90));
  canvas.cancel(pointer(120, 90));
  assert.deepEqual(canvas.cardSize("text"), { width: 500, height: 274 });
  canvas.begin(pointer(100, 100), "text");
  canvas.move(pointer(110, 105));
  canvas.end(pointer(110, 105));
  assert.deepEqual(canvas.positions.value.text, { x: 20, y: 10, width: 500, height: 274 });
});

test("real workflow inputs fan in and out, grouping files from the same source", () => {
  const node = (id: string, inputs: FlowNode["inputs"] = []): FlowNode => ({ id, kind: "command", title: id, config: {}, inputs });
  const links = workflowInputLinks([
    node("sources"), node("research"),
    node("writing", [{producerNodeId:"sources",artifactKey:"news"}, {producerNodeId:"sources",artifactKey:"fact-check"}, {producerNodeId:"research",artifactKey:"background"}]),
    node("review", [{producerNodeId:"sources",artifactKey:"news"}, {ref:{root:"canvas",path:"guide.md"}}, {producerNodeId:"missing",artifactKey:"skip"}])
  ]);
  assert.deepEqual(links.get("writing")?.map(({ from, artifactKeys }) => [from, artifactKeys]), [["sources", ["news", "fact-check"]], ["research", ["background"]]]);
  assert.deepEqual(links.get("review")?.map(({ from }) => from), ["sources"]);
  assert.equal(links.has("sources"), false);
});

test("grid thumbnails preserve resized media cards and their migrated canvas links", () => {
  const source: FlowNode = { id: "node-a", kind: "asset", config: { legacyCardId: "text-a" }, layout: { x: 0, y: 0, width: 493, height: 139 } };
  const target: FlowNode = { id: "node-b", kind: "asset", config: { legacyCardId: "video-b" }, layout: { x: 600, y: 25 } };
  const thumbnail = canvasGraphThumbnail({ version: 2, id: "canvas", name: "Media", revision: 1, workspaceBindingKey: "", variables: [],
    graph: { nodes: [source, target], edges: [], groups: [] }, mediaLinks: [{ from: "text-a", to: "video-b" }] });
  assert.equal(thumbnail?.wires.length, 1);
  assert.equal(thumbnail?.nodes[0]?.width, 493);
  assert.equal(thumbnail?.nodes[0]?.height, 139);
});

test("a material connection is saved as an input and rejects cycles or undeclared outputs", () => {
  const definition = JSON.parse(readFileSync(new URL("../../workbench-definition.json", import.meta.url), "utf8"));
  const material = { key: "report", path: "report.json", root: "output", freshness: "produced" };
  const nodes: FlowNode[] = ["first", "second"].map(id => ({ id, kind: "command", config: {}, requirements: [material] }));
  const initial = { nodes, edges: [], groups: [] };
  const graph = connectWorkflowInput(initial, definition, "first", "second", "report");
  assert.deepEqual(graph.nodes[1]?.inputs, [{ producerNodeId: "first", artifactKey: "report" }]);
  assert.equal(graph.edges.length, 0);
  assert.equal(connectWorkflowInput(graph, definition, "first", "second", "report"), graph);
  assert.throws(() => connectWorkflowInput(graph, definition, "second", "first", "report"), /循环依赖/);
  assert.throws(() => connectWorkflowInput(graph, definition, "first", "second", "unknown"), /产物/);
});

test("upstream edits are reflected in the inspector without overwriting other draft inputs", () => {
  const removed = { producerNodeId: "old", artifactKey: "report" };
  const added = { producerNodeId: "new", artifactKey: "report" };
  const draft = { ref: { root: "canvas", path: "notes.md" } };
  assert.deepEqual(rebaseWorkflowInputs([removed, draft], [removed], [added]), [draft, added]);
  assert.deepEqual(rebaseWorkflowInputs([draft], [], []), [draft]);
});
test("zoom preserves the world point under its anchor and clamps the supported range", async () => {
  const canvas = await fixture();
  const anchor = { x: 213, y: 117 }, before = canvas.world(anchor);
  canvas.zoom(1.7, anchor);
  assert.ok(Math.abs(canvas.world(anchor).x - before.x) < 1e-9);
  assert.ok(Math.abs(canvas.world(anchor).y - before.y) < 1e-9);
  canvas.zoom(100); assert.equal(canvas.scale.value, 2);
  canvas.zoom(0); assert.equal(canvas.scale.value, 0.05);
});
test("card dragging converts screen distance by zoom and ignores unrelated pointers", async () => {
  const canvas = await fixture(); canvas.add("a"); canvas.scale.value = 0.5;
  canvas.begin(pointer(10, 20), "a");
  canvas.move(pointer(110, 70, 2)); assert.deepEqual(canvas.positions.value.a, { x: 0, y: 0 });
  canvas.move(pointer(110, 70)); assert.deepEqual(canvas.positions.value.a, { x: 200, y: 100 });
  canvas.end(pointer(110, 70)); canvas.move(pointer(210, 100));
  assert.deepEqual(canvas.positions.value.a, { x: 200, y: 100 }); assert.equal(canvas.dragging.value, false);
});
test("hand mode pans without moving cards; fit includes cards at negative coordinates", async () => {
  const canvas = await fixture(); canvas.add("a"); canvas.add("b");
  canvas.handMode.value = true; canvas.begin(pointer(0, 0), "a"); canvas.move(pointer(100, 50)); canvas.end(pointer(100, 50));
  assert.deepEqual(canvas.positions.value.a, { x: 0, y: 0 });
  canvas.positions.value.a = { x: -4600, y: -100 };
  canvas.fit();
  assert.ok(canvas.scale.value < 0.25);
  for (const position of Object.values(canvas.positions.value)) {
    const point = canvas.world({ x: 0, y: 0 });
    assert.ok(position.x >= point.x && position.y >= point.y);
    const right = canvas.world({ x: 1200, y: 900 });
    assert.ok(position.x + 130 + 380 <= right.x && position.y + 34 + 214 <= right.y);
  }
});

test("left background drag selects cards without panning, then selected cards move together", async () => {
  const canvas = await fixture([
    { id: "a", left: 130, top: 34, width: 380, height: 214 },
    { id: "b", left: 850, top: 34, width: 380, height: 214 },
  ]); canvas.add("a"); canvas.add("b");
  const down = { ...pointer(0, 0), target: { closest() { return null; } } } as unknown as PointerEvent;
  const before = canvas.world({x:0,y:0});
  canvas.backgroundDown(down); canvas.move(pointer(1300,300)); canvas.end(pointer(1300,300));
  assert.deepEqual(canvas.selectedIds.value, ["a","b"]);
  assert.deepEqual(canvas.world({x:0,y:0}), before);
  canvas.begin(pointer(200,100),"a"); canvas.move(pointer(250,125)); canvas.end(pointer(250,125));
  assert.deepEqual(canvas.positions.value.a,{x:50,y:25});
  assert.deepEqual(canvas.positions.value.b,{x:770,y:25});
});
test("middle button pans without selecting or moving cards", async () => {
  const canvas = await fixture(); canvas.add("a"); canvas.selectedIds.value=["a"];
  const down = { ...pointer(0,0), button:1, target:{closest(){return null;}} } as unknown as PointerEvent;
  canvas.backgroundDown(down); canvas.move(pointer(80,40)); canvas.end(pointer(80,40));
  assert.deepEqual(canvas.positions.value.a,{x:0,y:0});
  assert.deepEqual(canvas.world({x:0,y:0}),{x:-80,y:-40});
  assert.deepEqual(canvas.selectedIds.value,["a"]);
});

test("a small pointer wobble selects without moving and keeps the click", async () => {
  const canvas = await fixture();
  canvas.add("a");
  let selections = 0;
  canvas.begin(pointer(10, 20), "a", () => { selections++; });
  canvas.move(pointer(13, 22));
  assert.equal(selections, 0);
  assert.equal(canvas.dragging.value, false);
  assert.equal(canvas.end(pointer(13, 22)), false);
  assert.equal(selections, 1);
  assert.deepEqual(canvas.positions.value.a, { x: 0, y: 0 });
  let clickPrevented = false;
  canvas.preventDragClick({ detail: 1, preventDefault() { clickPrevented = true; } } as MouseEvent);
  assert.equal(clickPrevented, false);
});

test("touch uses a larger drag threshold and a canceled drag restores the layout", async () => {
  const canvas = await fixture();
  canvas.add("a");
  const touch = { ...pointer(10, 20), pointerType: "touch" } as PointerEvent;
  canvas.begin(touch, "a", () => { canvas.selectedIds.value = ["a"]; });
  canvas.move(pointer(18, 20));
  assert.equal(canvas.dragging.value, false);
  assert.deepEqual(canvas.positions.value.a, { x: 0, y: 0 });
  canvas.move(pointer(23, 20));
  assert.deepEqual(canvas.positions.value.a, { x: 13, y: 0 });
  canvas.cancel(pointer(23, 20));
  assert.deepEqual(canvas.positions.value.a, { x: 0, y: 0 });
  assert.equal(canvas.dragging.value, false);
});

test("only a completed drag suppresses the following pointer click", async () => {
  const canvas = await fixture();
  canvas.begin(pointer(0, 0), "a");
  canvas.move(pointer(10, 0));
  assert.equal(canvas.end(pointer(10, 0)), true);
  let stopped = false;
  const click = { detail: 1, preventDefault() {}, stopPropagation() { stopped = true; } } as MouseEvent;
  canvas.preventDragClick({ ...click, detail: 0 } as MouseEvent);
  assert.equal(stopped, false);
  canvas.preventDragClick(click);
  assert.equal(stopped, true);
});

test("marquee uses the visible card rect and stays in screen pixels at low zoom", async () => {
  const canvas = await fixture([
    { id: "flow", left: 150, top: 80, width: 95, height: 19 },
    { id: "media", left: 275, top: 80, width: 95, height: 54 },
  ], { left: 100, top: 40 });
  canvas.scale.value = 0.25;
  canvas.add("flow"); canvas.add("media");
  canvas.begin(pointer(140, 105));
  canvas.move(pointer(260, 127));
  assert.deepEqual(canvas.marquee.value, { x: 40, y: 65, width: 120, height: 22 });
  assert.deepEqual(canvas.selectedIds.value, []);
  canvas.end(pointer(290, 128));
  assert.deepEqual(canvas.selectedIds.value, ["media"]);
  assert.equal(canvas.marquee.value, undefined);
});

test("modifier clicks and marquee preserve unrelated nodes, while a plain click selects only its card", async () => {
  const canvas = await fixture([
    { id: "a", left: 25, top: 30, width: 80, height: 50 },
    { id: "b", left: 140, top: 30, width: 80, height: 50 },
  ]);
  canvas.add("a"); canvas.add("b");
  canvas.selectedIds.value = ["a"];
  const clickB = pointer(150, 40);
  canvas.begin({ ...clickB, shiftKey: true }, "b"); canvas.end(clickB);
  assert.deepEqual(canvas.selectedIds.value, ["a", "b"]);
  canvas.begin({ ...pointer(125, 10), ctrlKey: true });
  canvas.move(pointer(235, 85));
  canvas.move(pointer(215, 75));
  canvas.end(pointer(215, 75));
  assert.deepEqual(canvas.selectedIds.value, ["a"]);
  canvas.begin(clickB, "b"); canvas.end(clickB);
  assert.deepEqual(canvas.selectedIds.value, ["b"]);
});

test("space temporarily pans and layout history treats a group move as one change", async () => {
  const canvas = await fixture();
  canvas.add("a"); canvas.add("b");
  canvas.selectedIds.value = ["a", "b"];
  canvas.spacePan.value = true;
  canvas.begin(pointer(0, 0), "a"); canvas.end(pointer(35, 15));
  assert.deepEqual(canvas.offset.value, { x: 35, y: 15 });
  assert.equal(canvas.canUndo.value, false);
  canvas.spacePan.value = false;
  canvas.begin(pointer(10, 10), "a"); canvas.move(pointer(20, 20)); canvas.end(pointer(60, 40));
  assert.deepEqual(canvas.positions.value, { a: { x: 50, y: 30 }, b: { x: 770, y: 30 } });
  assert.equal(canvas.restoreLayout(true), true);
  assert.deepEqual(canvas.positions.value, { a: { x: 0, y: 0 }, b: { x: 720, y: 0 } });
  assert.equal(canvas.restoreLayout(false), true);
  assert.deepEqual(canvas.positions.value.b, { x: 770, y: 30 });
  canvas.restoreLayout(true);
  canvas.nudge({ key: "ArrowRight", preventDefault() {} } as KeyboardEvent);
  assert.equal(canvas.canRedo.value, false);
  assert.deepEqual(canvas.positions.value, { a: { x: 10, y: 0 }, b: { x: 730, y: 0 } });
});
