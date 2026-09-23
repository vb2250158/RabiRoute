import assert from "node:assert/strict";
import test from "node:test";
import { paginateRoleMemory } from "./roleKnowledgePagination.js";

const counts = { recent: 1, consolidated: 0, archived: 0, consolidationRuns: 0 };

test("array traversal uses its iterator and reads getters in forward order", () => {
  const custom = ["ordinary"];
  custom[Symbol.iterator] = function* () { yield "iterator-needle"; return undefined; };
  assert.equal(paginateRoleMemory([custom], "", 8, "iterator-needle", counts).total, 1);
  const reads: number[] = [];
  const values = ["", ""];
  Object.defineProperty(values, 0, { get() { reads.push(0); return "first"; } });
  Object.defineProperty(values, 1, { get() { reads.push(1); return "second"; } });
  assert.equal(paginateRoleMemory([values], "", 8, "second", counts).total, 1);
  assert.deepEqual(reads, [0, 1]);
});

test("iterative knowledge traversal preserves field boundaries, case and cycles", () => {
  const item: Record<string, unknown> = {
    nested: [{ text: "Mixed NEEDLE" }], left: "cross", right: "field",
    fullwidth: "ＡＢＣ", numeric: 12345, shared: { text: "shared-value" }
  };
  item.again = item.shared;
  item.self = item;
  const search = (query: string) => paginateRoleMemory([item], "", 8, query, counts);
  assert.equal(search("  needle  ").total, 1);
  assert.equal(search("shared-value").total, 1);
  assert.equal(search("crossfield").total, 0);
  assert.equal(search("12345").total, 0);
  assert.equal(search("abc").total, 0, "plan/memory query does not apply NFKC");
  assert.equal(search("ａｂｃ").total, 1);
  assert.equal(search("missing").total, 0);
});

test("iterative traversal handles deeply nested knowledge without recursive stack overflow", () => {
  let item: unknown = "deep-target";
  for (let depth = 0; depth < 20000; depth++) item = { child: item };
  const page = paginateRoleMemory([item], "", 8, "deep-target", counts);
  assert.equal(page.total, 1);
  assert.equal(page.items[0], item);
});
