import assert from "node:assert/strict";
import test from "node:test";
import { activePlanIdAtAnchor, directoryScrollTopForItem } from "../src/planDirectoryScrollSync";

test("active plan follows the card crossing the reading anchor", () => {
  const rects = [
    { id: "first", top: -240, bottom: 120 },
    { id: "second", top: 130, bottom: 480 },
    { id: "third", top: 490, bottom: 820 }
  ];

  assert.equal(activePlanIdAtAnchor(rects, 150), "second");
  assert.equal(activePlanIdAtAnchor(rects, 500), "third");
  assert.equal(activePlanIdAtAnchor(rects, 900), "third");
});

test("directory only scrolls when the active entry leaves its own viewport", () => {
  assert.equal(directoryScrollTopForItem({
    scrollTop: 200,
    viewportTop: 100,
    viewportBottom: 500,
    itemTop: 180,
    itemBottom: 224,
    padding: 6
  }), null);

  assert.equal(directoryScrollTopForItem({
    scrollTop: 200,
    viewportTop: 100,
    viewportBottom: 500,
    itemTop: 80,
    itemBottom: 124,
    padding: 6
  }), 174);

  assert.equal(directoryScrollTopForItem({
    scrollTop: 200,
    viewportTop: 100,
    viewportBottom: 500,
    itemTop: 490,
    itemBottom: 534,
    padding: 6
  }), 240);
});
