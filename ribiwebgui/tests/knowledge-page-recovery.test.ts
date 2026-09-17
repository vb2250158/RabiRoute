import assert from "node:assert/strict";
import test from "node:test";
import { drainKnowledgePages } from "../src/knowledgePagination";
import { ROLE_PLAN_PAGE_SIZE, ROLE_PLAN_BACKGROUND_PAGE_SIZE } from "../src/roleKnowledgeClient";

test("first eight remain usable when a background page stalls and retry resumes its cursor serially", async () => {
  assert.equal(ROLE_PLAN_PAGE_SIZE, 8);
  assert.equal(ROLE_PLAN_BACKGROUND_PAGE_SIZE, 100);
  const rows = Array.from({ length: 618 }, (_, id) => id);
  const loaded = rows.slice(0, ROLE_PLAN_PAGE_SIZE);
  let cursor = "8";
  let fail = true;
  let active = 0;
  let maximum = 0;
  const requests: string[] = [];
  const options = {
    nextCursor: () => cursor,
    shouldContinue: () => true,
    loadNextPage: async () => {
      active++; maximum = Math.max(maximum, active); requests.push(cursor);
      try {
        await Promise.resolve();
        if (fail) { fail = false; return; }
        const start = Number(cursor);
        loaded.push(...rows.slice(start, start + ROLE_PLAN_BACKGROUND_PAGE_SIZE));
        cursor = start + ROLE_PLAN_BACKGROUND_PAGE_SIZE < rows.length ? String(start + ROLE_PLAN_BACKGROUND_PAGE_SIZE) : "";
      } finally { active--; }
    }
  };
  assert.equal(await drainKnowledgePages(options), "stalled");
  assert.equal(loaded.length, 8);
  assert.equal(cursor, "8");
  assert.equal(await drainKnowledgePages(options), "completed");
  assert.deepEqual(loaded, rows);
  assert.equal(maximum, 1);
  assert.deepEqual(requests, ["8", "8", "108", "208", "308", "408", "508", "608"]);
});

test("invalidated background read stops without asking for another page", async () => {
  let current = true;
  let calls = 0;
  const result = await drainKnowledgePages({ nextCursor: () => "8", shouldContinue: () => current,
    yieldToUi: async () => { current = false; }, loadNextPage: async () => { calls++; } });
  assert.equal(result, "stopped");
  assert.equal(calls, 0);
});
