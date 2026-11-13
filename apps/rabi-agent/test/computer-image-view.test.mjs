import assert from "node:assert/strict";
import test from "node:test";
import { COMPUTER_IMAGE_VIEW_CAPABILITY, computerRequestUsesImageView, computerRequestSchemaSupportsImageView } from "../lib/computer-image-view.mjs";
import { computerRequestSchema } from "../lib/interactive-protocol.mjs";

const source = { frameId: "cached-frame", coordinateSpace: "capture", width: 1920, height: 1080, imageView: { width: 512, height: 288 } };

for (const [type, coordinates] of [
  ["move", { x: 256, y: 144 }], ["click", { x: 256, y: 144 }],
  ["drag", { x: 1, y: 2, toX: 3, toY: 4 }], ["scroll", { x: 256, y: 144, deltaY: 1 }],
]) {
  test(`scaled image coordinates are required by ${type}`, () => {
    assert.equal(computerRequestUsesImageView("input.execute", { source, actions: [{ type, ...coordinates }] }), true);
  });
}

for (const input of [
  { type: "text", text: "fixture" }, { type: "key", keys: ["Enter"] },
  { type: "scroll", deltaY: 1 }, { type: "scroll", x: 256, deltaY: 1 }, { type: "scroll", y: 144, deltaY: 1 },
]) {
  test(`non-positioned ${input.type} ${Object.keys(input).join("/")} retains legacy execution`, () => {
    assert.equal(computerRequestUsesImageView("input.execute", { source, actions: [input] }), false);
  });
}

test("equal-sized views and uncached desktop coordinates retain their original format", () => {
  const actions = [{ type: "click", x: 256, y: 144 }];
  assert.equal(computerRequestUsesImageView("input.execute", { source: { ...source, imageView: { width: 1920, height: 1080 } }, actions }), false);
  assert.equal(computerRequestUsesImageView("input.execute", { source: { ...source, frameId: undefined, coordinateSpace: "desktop" }, actions }), false);
  assert.equal(computerRequestUsesImageView("input.execute", { source: { ...source, coordinateSpace: "desktop" }, actions }), true);
  assert.equal(COMPUTER_IMAGE_VIEW_CAPABILITY, "imageView-v1");
});

for (const action of ["input.status", "input.cancel", "control.status", "control.end", "annotation.clear", "annotation.track.stop", "screen.capture", "file.read"]) {
  test(`${action} remains independent of image-view execution`, () => {
    assert.equal(computerRequestUsesImageView(action, { source }), false);
  });
}

for (const action of ["input.execute", "annotation.show", "annotation.update", "annotation.track.start"]) {
  test(`current receiver contract explicitly declares imageView for ${action}`, () => {
    assert.equal(computerRequestSchemaSupportsImageView(computerRequestSchema, action), true);
  });
}

test("additional properties do not declare a coordinate format", () => {
  const schema = { properties: { source: { type: "object", additionalProperties: true } } };
  assert.equal(computerRequestSchemaSupportsImageView(schema, "input.execute"), false);
});

test("receiver declarations follow the selected action and local references", () => {
  const schema = {
    $defs: { source: { properties: { imageView: { properties: { width: { type: "integer" }, height: { type: "integer" } } } } } },
    oneOf: [
      { properties: { action: { const: "annotation.show" }, source: { $ref: "#/$defs/source" } } },
      { properties: { action: { const: "input.execute" }, source: { additionalProperties: true } } },
    ],
  };
  assert.equal(computerRequestSchemaSupportsImageView(schema, "annotation.show"), true);
  assert.equal(computerRequestSchemaSupportsImageView(schema, "input.execute"), false);
  assert.equal(computerRequestSchemaSupportsImageView({ $ref: "#/$defs/cycle", $defs: { cycle: { $ref: "#/$defs/cycle" } } }, "input.execute"), false);
});
