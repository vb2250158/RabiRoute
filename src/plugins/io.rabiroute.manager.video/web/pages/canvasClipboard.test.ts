import assert from "node:assert/strict";
import test from "node:test";
import { CANVAS_CLIPBOARD_LIMIT, copiedNodeTitle, createCanvasClipboard, parseCanvasClipboard, pasteLayouts, type CanvasClipboardEntry } from "./canvasClipboard";

const media: CanvasClipboardEntry = { type: "media", data: { kind: "text", title: "文本 1", text: "镜头" }, layout: { x: 100, y: 200, width: 380, height: 214 } };
const workflow: CanvasClipboardEntry = { type: "workflow", data: { kind: "agent", title: "Agent 1", config: { textPrompt: "" }, enabled: true }, layout: { x: 600, y: 200 } };

test("only clipboard JSON written by this canvas is accepted", () => {
  const clipboard = createCanvasClipboard([media, workflow]);
  assert.deepEqual(parseCanvasClipboard(JSON.stringify(clipboard)), clipboard);
  assert.equal(parseCanvasClipboard("not json"), undefined);
  assert.equal(parseCanvasClipboard(""), undefined);
  assert.equal(parseCanvasClipboard(undefined), undefined);
  assert.equal(parseCanvasClipboard(JSON.stringify({ version: 1, entries: [media] })), undefined);
  assert.equal(parseCanvasClipboard(JSON.stringify({ scope: "rabi-video-canvas", version: 2, entries: [media] })), undefined);
  assert.equal(parseCanvasClipboard(JSON.stringify({ scope: "rabi-video-canvas", version: 1, entries: [] })), undefined);
  assert.equal(parseCanvasClipboard(JSON.stringify({ scope: "other", version: 1, entries: [media] })), undefined);
});

test("entries outside the media and workflow contract are dropped, valid siblings survive", () => {
  const parsed = parseCanvasClipboard(JSON.stringify({
    scope: "rabi-video-canvas", version: 1,
    entries: [
      { type: "media", data: { kind: "video", title: "视频 1" }, draft: { prompt: "p" } },
      { type: "media", data: { kind: "script", title: "未知类型" } },
      { type: "workflow", data: { kind: "agent", config: { textPrompt: "" } } },
      { type: "workflow", data: { kind: "agent" } },
      { type: "workflow", data: { config: {} } },
      { type: "edge", data: { kind: "agent", config: {} } },
      "broken"
    ]
  }));
  assert.equal(parsed?.entries.length, 2);
  assert.equal(parsed?.entries[0]?.type, "media");
  assert.deepEqual(parsed?.entries[0]?.type === "media" ? parsed.entries[0].draft : undefined, { prompt: "p" });
  assert.equal(parsed?.entries[1]?.type, "workflow");
  assert.equal(createCanvasClipboard(Array.from({ length: CANVAS_CLIPBOARD_LIMIT + 5 }, () => media)).entries.length, CANVAS_CLIPBOARD_LIMIT);
});

test("layouts that cannot be placed are ignored instead of producing NaN positions", () => {
  const parsed = parseCanvasClipboard(JSON.stringify({
    scope: "rabi-video-canvas", version: 1,
    entries: [
      { type: "media", data: { kind: "text" }, layout: { x: "12", y: 4 } },
      { type: "media", data: { kind: "text" }, layout: { x: 12, y: 4, width: "wide" } }
    ]
  }));
  assert.equal(parsed?.entries[0]?.layout, undefined);
  assert.deepEqual(parsed?.entries[1]?.layout, { x: 12, y: 4 });
});

test("pasted titles keep a single copy suffix", () => {
  assert.equal(copiedNodeTitle("文本 1"), "文本 1 副本");
  assert.equal(copiedNodeTitle("文本 1 副本"), "文本 1 副本");
  assert.equal(copiedNodeTitle("  "), "节点 副本");
  assert.equal(copiedNodeTitle(undefined, "分组"), "分组 副本");
});

test("paste keeps the relative shape and either steps aside or aligns to the pointer", () => {
  const entries = [{ layout: { x: 100, y: 200 } }, { layout: { x: 600, y: 320 } }];
  assert.deepEqual(pasteLayouts(entries), [{ x: 140, y: 240 }, { x: 640, y: 360 }]);
  assert.deepEqual(pasteLayouts(entries, { offset: 80 }), [{ x: 180, y: 280 }, { x: 680, y: 400 }]);
  assert.deepEqual(pasteLayouts(entries, { anchor: { x: 0, y: 0 } }), [{ x: 0, y: 0 }, { x: 500, y: 120 }]);
  assert.deepEqual(pasteLayouts(entries, { anchor: { x: -300, y: 40 } }), [{ x: -300, y: 40 }, { x: 200, y: 160 }]);
});

test("pasting nodes without a layout stacks them instead of overlapping", () => {
  assert.deepEqual(pasteLayouts([{}, {}]), [{ x: 40, y: 40 }, { x: 80, y: 80 }]);
  assert.deepEqual(pasteLayouts([{ layout: { x: 10, y: 10 } }, {}], { offset: 20 }), [{ x: 30, y: 30 }, { x: 70, y: 70 }]);
});
