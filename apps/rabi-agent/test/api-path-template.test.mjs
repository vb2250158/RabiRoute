import assert from "node:assert/strict";
import test from "node:test";
import { apiPathTemplatesEquivalent, apiTailPathsOverlap, fillApiPathTemplate, parseApiPathTemplate } from "../lib/api-path-template.mjs";

test("reusing parsed metadata cannot share mutable regular expression state", () => {
  const first = parseApiPathTemplate("/items/:id");
  first.pattern.compile("^/wrong$", "g");
  first.pattern.lastIndex = 40;
  const next = parseApiPathTemplate("/items/:id");
  assert.notEqual(next, first);
  assert.notEqual(next.pattern, first.pattern);
  assert.equal(next.pattern.lastIndex, 0);
  assert.equal(next.pattern.test("/items/one"), true);
  assert.equal(Object.isFrozen(next.names), true);
  assert.equal(Object.isFrozen(next.segments), true);
  assert.equal(Object.isFrozen(next.segments[1]), true);
  assert.throws(() => { next.segments[1].literal = "wrong"; }, TypeError);
  assert.equal(apiPathTemplatesEquivalent("/items/:id", "/items/:other"), true);
  assert.equal(fillApiPathTemplate("/items/:id", { id: "one two" }), "/items/one%20two");
});

test("cache identity includes tail, raw remainder, and explicit literal case semantics", () => {
  const tails = ["path"], literalCase = ["API"];
  assert.equal(parseApiPathTemplate("/API/:path", tails, "", literalCase).pattern.test("/api/one/two"), true);
  tails.length = 0;
  literalCase.length = 0;
  const ordinary = parseApiPathTemplate("/API/:path", tails, "", literalCase);
  assert.equal(ordinary.pattern.test("/api/one/two"), false);
  assert.equal(ordinary.pattern.test("/API/one/two"), false);
  assert.equal(parseApiPathTemplate("/API/:path", ["path"]).pattern.test("/API/one/two"), true);
  assert.equal(parseApiPathTemplate("/asset:rest", [], "rest").pattern.test("/asset/one/two"), true);
  assert.equal(parseApiPathTemplate("/asset:rest").pattern.test("/asset/one/two"), false);
  assert.equal(apiPathTemplatesEquivalent("/API/:id", "/api/:name", ["API"]), true);
  assert.equal(apiPathTemplatesEquivalent("/API/:id", "/api/:name"), false);
  assert.equal(apiTailPathsOverlap("/files/:path", "/files/one/two", ["path"]), true);
  assert.equal(fillApiPathTemplate("/files/:path", { path: "one/two three" }, ["path"]), "/files/one/two%20three");
  assert.equal(fillApiPathTemplate("/asset:rest", { rest: "/one/two" }, [], "rest"), "/asset/one/two");
});

test("warm templates still reject duplicate or invalid declarations and bindings", () => {
  parseApiPathTemplate("/API/:id", [], "", ["API"]);
  const invalid = [
    () => parseApiPathTemplate("/API/:id", [], "", ["API", "API"]),
    () => parseApiPathTemplate("/API/:id", ["id", "id"]),
    () => parseApiPathTemplate("/API/:id", [], "", ["missing"]),
    () => parseApiPathTemplate("/API/:id", ["missing"]),
    () => parseApiPathTemplate("/API/:id", [], "missing"),
    () => parseApiPathTemplate("/API/:id", ["id"], "id"),
    () => parseApiPathTemplate("/API/:id/:id"),
    () => parseApiPathTemplate("/API/:id/next", ["id"]),
    () => parseApiPathTemplate("/API/../:id"),
    () => parseApiPathTemplate("/API/:id?query=one"),
    () => fillApiPathTemplate("/files/:path", { path: "one/../two" }, ["path"]),
    () => fillApiPathTemplate("/asset:rest", { rest: "?query" }, [], "rest")
  ];
  for (const operation of invalid) assert.throws(operation, /Invalid|Unknown/);
});

test("metadata eviction and oversized uncached templates preserve matching", () => {
  const first = parseApiPathTemplate("/cache-first/:id");
  for (let index = 0; index < 1100; index++) parseApiPathTemplate(`/cache-${index}/:id`);
  const recomputed = parseApiPathTemplate("/cache-first/:id");
  assert.notEqual(recomputed.segments, first.segments);
  assert.equal(recomputed.pattern.source, first.pattern.source);
  const template = "/" + "x".repeat(4200) + "/:id";
  assert.equal(parseApiPathTemplate(template).pattern.test(template.replace(":id", "one")), true);
  assert.notEqual(parseApiPathTemplate(template).segments, parseApiPathTemplate(template).segments);
});
