import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("history displays actor before action/date and separates navigation from disclosure", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const page = fs.readFileSync(path.join(root, "src/pages/RoleKnowledgePage.vue"), "utf8");
  const history = page.slice(page.indexOf('<details v-for="record in planHistoryRecords'));
  assert.ok(history.indexOf("historyActorLabel(record)") < history.indexOf("planHistoryLabel(record)"));
  assert.ok(history.indexOf("planHistoryLabel(record)") < history.indexOf("formatDate(record.recordedAt)"));
  assert.match(history, /@click.stop.prevent="openHistoryActor\(plan, record\)"/);
  assert.match(history, /knowledge-plan-history-summary/);
  assert.match(page, /来源未知/);
  const client = fs.readFileSync(path.join(root, "src/roleKnowledgeClient.ts"), "utf8");
  assert.match(client, /openPlanHistoryAgent[\s\S]*?JSON.stringify\(\{ historyId \}\)/);
});
