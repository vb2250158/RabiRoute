import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createFrameBudgetTreeScheduler } from "../src/i18n/frameBudgetTreeScheduler";

type TestNode = {
  id: string;
  children?: TestNode[];
};

test("large trees are split across frame-budgeted batches", () => {
  const callbacks: Array<() => void> = [];
  const processed: string[] = [];
  let clock = 0;
  const scheduler = createFrameBudgetTreeScheduler<TestNode>({
    process: node => {
      processed.push(node.id);
      clock += 1;
    },
    children: node => node.children ?? [],
    schedule: callback => {
      callbacks.push(callback);
      return callbacks.length;
    },
    cancel: () => undefined,
    now: () => clock,
    budgetMs: 4,
    maxNodesPerFrame: 100
  });

  scheduler.enqueue({
    id: "root",
    children: Array.from({ length: 20 }, (_, index) => ({ id: `child-${index}` }))
  });

  assert.equal(callbacks.length, 1);
  callbacks.shift()?.();
  assert.equal(processed.length, 4);
  assert.equal(callbacks.length, 1);

  while (callbacks.length) callbacks.shift()?.();
  assert.equal(processed.length, 21);
});

test("node count also bounds a frame when work is too fast to measure", () => {
  const callbacks: Array<() => void> = [];
  let processed = 0;
  const scheduler = createFrameBudgetTreeScheduler<TestNode>({
    process: () => { processed += 1; },
    children: node => node.children ?? [],
    schedule: callback => {
      callbacks.push(callback);
      return callbacks.length;
    },
    cancel: () => undefined,
    now: () => 0,
    budgetMs: 4,
    maxNodesPerFrame: 3
  });

  scheduler.enqueue({
    id: "root",
    children: Array.from({ length: 9 }, (_, index) => ({ id: `child-${index}` }))
  });
  callbacks.shift()?.();

  assert.equal(processed, 3);
  assert.equal(callbacks.length, 1);
});

test("DOM localization skips Chinese mutation scans and uses the frame scheduler", () => {
  const source = fs.readFileSync(new URL("../src/i18n/domLocalizer.ts", import.meta.url), "utf8");

  assert.match(source, /if \(locale === "zh-CN"\) return;/);
  assert.match(source, /createFrameBudgetTreeScheduler<Node>/);
  assert.match(source, /budgetMs: 4/);
  assert.match(source, /maxNodesPerFrame: 200/);
  assert.doesNotMatch(source, /createTreeWalker/);
});
