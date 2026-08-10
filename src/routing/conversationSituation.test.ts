import assert from "node:assert/strict";
import test from "node:test";
import { conversationSituationForIdentity, conversationSituationLines } from "./conversationSituation.js";

test("conversation situation exposes scoped project discussion without granting project-management authority", () => {
  const situation = conversationSituationForIdentity({
    endpoint: { id: "account", platform: "napcat", endpointIdentityNamespace: "bot:1", senderStableId: "200" },
    confirmedParticipant: { id: "participant-cotton", kind: "person", displayName: "COTTON", aliases: [], status: "confirmed", evidenceRefs: [], updatedAt: "2026-08-10T00:00:00.000Z" },
    candidateParticipants: [],
    relevantRelations: [{
      id: "relation-edge-space", subjectParticipantId: "participant-cotton", targetKind: "project", targetId: "edge-space",
      relationship: "参与讨论", status: "confirmed", scope: { conversationKeys: ["napcat:group:100"], projectIds: [] }, evidenceRefs: [], updatedAt: "2026-08-10T00:00:00.000Z"
    }],
    unresolved: []
  });
  assert.deepEqual(situation.topic, {
    kind: "project_discussion",
    projectCandidates: [{ projectId: "edge-space", status: "confirmed", relationship: "参与讨论" }]
  });
  assert.equal(situation.decisions.mayParticipate, true);
  assert.equal(situation.decisions.mayCreateOrUpdateCurrentProjectRecords, false);
  assert.match(conversationSituationLines(situation).join("\n"), /不得据此查询、创建、更新或转交任何项目计划/);
});

test("conversation situation does not invent a project from an unknown conversation", () => {
  const situation = conversationSituationForIdentity(undefined);
  assert.equal(situation.topic.kind, "unknown");
  assert.deepEqual(situation.topic.projectCandidates, []);
  assert.equal(situation.decisions.mayCreateOrUpdateCurrentProjectRecords, false);
});
