import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PersonaSyncService } from "./personaSync.js";
import {
  identityRelationsPath,
  listIdentityEndpointAccounts,
  listIdentityParticipants,
  listIdentityRelationCards,
  resolveIdentityRelationContext,
  updateIdentityRelation
} from "./identityRelations.js";

test("identity relations use platform, endpoint namespace, and stable sender id instead of route identity", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-identity-relations-"));
  const participant = updateIdentityRelation(roleDir, {
    kind: "participant",
    participantId: "participant-cotton",
    participantKind: "person",
    displayName: "COTTON",
    status: "confirmed",
    aliases: [],
    evidenceRefs: [{ messageId: "m-confirm" }]
  }).record;
  updateIdentityRelation(roleDir, {
    kind: "endpoint_account",
    platform: "napcat",
    endpointIdentityNamespace: "instance:qq-main",
    senderStableId: "10001",
    displayName: "COTTON",
    participantLinks: [{ participantId: participant.id, status: "confirmed", confidence: 1, evidenceRefs: [{ messageId: "m-confirm" }] }]
  });

  const accounts = listIdentityEndpointAccounts(roleDir);
  assert.equal(accounts.length, 1);
  const acrossAnotherRoute = resolveIdentityRelationContext(roleDir, {
    platform: "napcat", endpointIdentityNamespace: "instance:qq-main", senderStableId: "10001", conversationKey: "napcat:group:other-route:1"
  });
  assert.equal(acrossAnotherRoute?.confirmedParticipant?.id, "participant-cotton");
  const otherInstance = resolveIdentityRelationContext(roleDir, {
    platform: "napcat", endpointIdentityNamespace: "instance:qq-second", senderStableId: "10001"
  });
  assert.equal(otherInstance?.confirmedParticipant, undefined);
  assert.match(otherInstance?.unresolved.join("\n") || "", /尚未建立身份关系记录/);
  const events = fs.readFileSync(identityRelationsPath(roleDir), "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(events.length, 2);
  assert.equal(events[0]?.knowledgeType, "identity_relation");
});

test("identity candidates remain non-authoritative and relation cards respect conversation scope", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-identity-relations-scope-"));
  updateIdentityRelation(roleDir, {
    kind: "participant", participantId: "participant-candidate", participantKind: "person",
    displayName: "待确认成员", status: "candidate", aliases: [], evidenceRefs: [{ messageId: "m-1" }]
  });
  updateIdentityRelation(roleDir, {
    kind: "endpoint_account", platform: "napcat", endpointIdentityNamespace: "instance:qq-main", senderStableId: "10002",
    participantLinks: [{ participantId: "participant-candidate", status: "candidate", confidence: 0.4, evidenceRefs: [{ messageId: "m-1" }] }]
  });
  updateIdentityRelation(roleDir, {
    kind: "relation_card", relationId: "relation-b4f8", subjectParticipantId: "participant-candidate",
    targetKind: "project", targetId: "project-other", relationship: "参与讨论", status: "candidate",
    scope: { conversationKeys: ["napcat:group:b4f8"], projectIds: [] }, evidenceRefs: [{ messageId: "m-1" }]
  });
  updateIdentityRelation(roleDir, {
    kind: "relation_card", relationId: "relation-old", subjectParticipantId: "participant-candidate",
    targetKind: "project", targetId: "project-old", relationship: "旧职责", status: "corrected",
    scope: { conversationKeys: [], projectIds: [] }, evidenceRefs: [{ messageId: "m-correction" }]
  });

  const inGroup = resolveIdentityRelationContext(roleDir, {
    platform: "napcat", endpointIdentityNamespace: "instance:qq-main", senderStableId: "10002", conversationKey: "napcat:group:b4f8"
  });
  assert.equal(inGroup?.confirmedParticipant, undefined);
  assert.equal(inGroup?.candidateParticipants[0]?.participant.id, "participant-candidate");
  assert.deepEqual(inGroup?.relevantRelations.map(item => item.id), ["relation-b4f8"]);
  assert.match(inGroup?.unresolved.join("\n") || "", /不能用于称呼、授权或项目归属/);

  const elsewhere = resolveIdentityRelationContext(roleDir, {
    platform: "napcat", endpointIdentityNamespace: "instance:qq-main", senderStableId: "10002", conversationKey: "napcat:group:elsewhere"
  });
  assert.equal(elsewhere?.relevantRelations.length, 0);
  assert.deepEqual(listIdentityRelationCards(roleDir).map(item => item.id), ["relation-b4f8", "relation-old"]);
});

test("identity corrections append a new event and replace the current relation state", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-identity-relations-correct-"));
  updateIdentityRelation(roleDir, {
    kind: "participant", participantId: "participant-a", participantKind: "person", displayName: "旧称呼",
    status: "candidate", aliases: [], evidenceRefs: []
  });
  updateIdentityRelation(roleDir, {
    kind: "participant", participantId: "participant-a", displayName: "确认称呼", status: "confirmed"
  });
  const participant = listIdentityParticipants(roleDir).find(item => item.id === "participant-a");
  assert.equal(participant?.displayName, "确认称呼");
  assert.equal(participant?.status, "confirmed");
  assert.equal(fs.readFileSync(identityRelationsPath(roleDir), "utf8").trim().split(/\r?\n/).length, 2);
});

test("identity record IDs remain opaque and may contain delimiters", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-identity-relations-id-"));
  updateIdentityRelation(roleDir, {
    kind: "participant", participantId: "external:directory:42", participantKind: "person", displayName: "带分隔符的 ID",
    status: "confirmed", aliases: [], evidenceRefs: []
  });
  assert.equal(listIdentityParticipants(roleDir)[0]?.id, "external:directory:42");
});

test("concurrent identity-relation branches stay conflicted until one explicit update supersedes both", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-identity-relations-sync-"));
  const rolesA = path.join(root, "a", "roles");
  const rolesB = path.join(root, "b", "roles");
  const roleA = path.join(rolesA, "Rabi");
  const roleB = path.join(rolesB, "Rabi");
  updateIdentityRelation(roleA, {
    kind: "participant", participantId: "participant-cotton", participantKind: "person", displayName: "COTTON",
    status: "confirmed", aliases: [], evidenceRefs: []
  });
  updateIdentityRelation(roleA, {
    kind: "endpoint_account", platform: "napcat", endpointIdentityNamespace: "bot:999", senderStableId: "200",
    participantLinks: [{ participantId: "participant-cotton", status: "confirmed", evidenceRefs: [] }]
  });
  fs.mkdirSync(path.dirname(identityRelationsPath(roleB)), { recursive: true });
  fs.copyFileSync(identityRelationsPath(roleA), identityRelationsPath(roleB));
  updateIdentityRelation(roleA, {
    kind: "participant", participantId: "participant-cotton", participantKind: "person", displayName: "COTTON A",
    status: "confirmed", aliases: ["A"], evidenceRefs: [{ messageId: "a" }]
  });
  updateIdentityRelation(roleB, {
    kind: "participant", participantId: "participant-cotton", participantKind: "person", displayName: "COTTON B",
    status: "confirmed", aliases: ["B"], evidenceRefs: [{ messageId: "b" }]
  });
  const service = new PersonaSyncService(() => rolesA, path.join(root, "sync"));
  const remote = fs.readFileSync(identityRelationsPath(roleB));
  service.merge({
    roleId: "Rabi",
    path: "identity-relations/events.jsonl",
    contentBase64: remote.toString("base64"),
    peerId: "pc-b"
  });
  const conflicted = listIdentityParticipants(roleA).find(item => item.id === "participant-cotton");
  assert.equal(conflicted?.conflicted, true);
  assert.equal(conflicted?.conflictCandidates?.length, 2);
  assert.deepEqual(
    conflicted?.conflictCandidates?.map(candidate => "displayName" in candidate.record ? candidate.record.displayName : undefined).sort(),
    ["COTTON A", "COTTON B"]
  );
  assert.equal(resolveIdentityRelationContext(roleA, {
    platform: "napcat", endpointIdentityNamespace: "bot:999", senderStableId: "200"
  })?.confirmedParticipant, undefined);
  assert.throws(() => updateIdentityRelation(roleA, {
    kind: "participant", participantId: "participant-cotton", displayName: "不完整修正"
  }), /requires explicit fields/);
  updateIdentityRelation(roleA, {
    kind: "participant", participantId: "participant-cotton", participantKind: "person", displayName: "COTTON",
    status: "confirmed", aliases: [], evidenceRefs: [{ messageId: "resolved" }]
  });
  const resolved = listIdentityParticipants(roleA).find(item => item.id === "participant-cotton");
  assert.equal(resolved?.conflicted, undefined);
  assert.equal(resolved?.displayName, "COTTON");
  const rows = fs.readFileSync(identityRelationsPath(roleA), "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(rows.at(-1)?.supersedes.length, 2);
});
