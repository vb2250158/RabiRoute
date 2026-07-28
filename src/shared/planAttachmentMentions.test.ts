import assert from "node:assert/strict";
import test from "node:test";
import {
  findPlanAttachmentMentionQuery,
  insertPlanAttachmentMention,
  planAttachmentMentionCandidates,
  referencedPlanAttachmentIds
} from "./planAttachmentMentions.js";

test("plan attachment mentions open after @ and insert a stable visible token", () => {
  const query = findPlanAttachmentMentionQuery("请看 @ga", "请看 @ga".length);
  assert.deepEqual(query, { start: 3, end: 6, query: "ga" });
  assert.deepEqual(
    insertPlanAttachmentMention("请看 @ga", query!, "@附件「gacha-review.png」"),
    { text: "请看 @附件「gacha-review.png」 ", caret: 25 }
  );
  assert.deepEqual(findPlanAttachmentMentionQuery("请看@图", "请看@图".length), { start: 2, end: 4, query: "图" });
  assert.equal(findPlanAttachmentMentionQuery("mail@example.com", "mail@example.com".length), null);
});

test("plan attachment mention candidates disambiguate duplicate names and resolve ids from text", () => {
  const candidates = planAttachmentMentionCandidates([
    { id: "image-a", name: "review.png" },
    { id: "image-b", name: "review.png" },
    { id: "report", name: "report.md" }
  ]);
  assert.deepEqual(candidates.map((item) => item.token), [
    "@附件「review.png（1）」",
    "@附件「review.png（2）」",
    "@附件「report.md」"
  ]);
  assert.deepEqual(
    referencedPlanAttachmentIds(`先按 ${candidates[1]!.token}，再看 ${candidates[2]!.token}`, candidates),
    ["image-b", "report"]
  );
});
