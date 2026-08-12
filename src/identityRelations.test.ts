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
  observeIdentityEndpoint,
  recordIdentityCandidateObservation,
  resolveIdentityRelationContext,
  updateIdentityRelation
} from "./identityRelations.js";

test("a stable unknown endpoint automatically becomes one idempotent candidate identity", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-identity-observe-"));
  const first = observeIdentityEndpoint(roleDir, {
    platform: "napcat",
    endpointIdentityNamespace: "bot:999",
    senderStableId: "200",
    displayName: "第一次看到的昵称",
    conversationKey: "napcat:group:b4f8"
  });
  assert.equal(first.accountCreated, true);
  assert.equal(first.participantCreated, true);
  assert.equal(first.context?.confirmedParticipant, undefined);
  assert.equal(first.context?.candidateParticipants.length, 1);
  assert.equal(first.context?.candidateParticipants[0]?.participant.kind, "unknown");
  assert.equal(first.context?.candidateParticipants[0]?.link.confidence, 0.1);
  const eventCount = fs.readFileSync(identityRelationsPath(roleDir), "utf8").trim().split(/\r?\n/).length;

  const repeated = observeIdentityEndpoint(roleDir, {
    platform: "napcat",
    endpointIdentityNamespace: "bot:999",
    senderStableId: "200",
    displayName: "第一次看到的昵称",
    conversationKey: "napcat:group:b4f8"
  });
  assert.equal(repeated.updated, false);
  assert.equal(fs.readFileSync(identityRelationsPath(roleDir), "utf8").trim().split(/\r?\n/).length, eventCount);
});

test("automatic identity learning appends evidence-backed clues but cannot confirm the candidate", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-identity-learn-"));
  const observed = observeIdentityEndpoint(roleDir, {
    platform: "napcat", endpointIdentityNamespace: "bot:999", senderStableId: "201", displayName: "群友"
  });
  const learned = recordIdentityCandidateObservation(roleDir, {
    platform: "napcat",
    endpointIdentityNamespace: "bot:999",
    senderStableId: "201",
    participantId: observed.participantId,
    participantKind: "person",
    participantDisplayName: "小林",
    aliases: ["林同学"],
    conversationKey: "napcat:group:b4f8",
    evidenceRefs: [{ conversationKey: "napcat:group:b4f8", messageId: "m-identity-1", note: "对方明确自称小林。" }],
    relations: [{ targetKind: "organization", targetId: "cotton-game", relationship: "自称是团队成员" }]
  });
  assert.equal(learned.appended, true);
  assert.equal(learned.participant.displayName, "小林");
  assert.equal(learned.participant.status, "candidate");
  assert.equal(learned.relations[0]?.status, "candidate");
  assert.deepEqual(learned.relations[0]?.scope.conversationKeys, ["napcat:group:b4f8"]);
  assert.match(resolveIdentityRelationContext(roleDir, {
    platform: "napcat", endpointIdentityNamespace: "bot:999", senderStableId: "201", conversationKey: "napcat:group:b4f8"
  })?.unresolved.join("\n") || "", /不能用于称呼、授权或项目归属/);
});

test("automatic identity observations from two PCs merge display-name clues without creating an identity conflict", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-identity-observe-sync-"));
  const rolesA = path.join(root, "a", "roles");
  const rolesB = path.join(root, "b", "roles");
  const roleA = path.join(rolesA, "Rabi");
  const roleB = path.join(rolesB, "Rabi");
  observeIdentityEndpoint(roleA, {
    platform: "napcat", endpointIdentityNamespace: "bot:999", senderStableId: "202", displayName: "群昵称 A"
  });
  observeIdentityEndpoint(roleB, {
    platform: "napcat", endpointIdentityNamespace: "bot:999", senderStableId: "202", displayName: "群昵称 B"
  });
  const service = new PersonaSyncService(() => rolesA, path.join(root, "sync"));
  service.merge({
    roleId: "Rabi",
    path: "identity-relations/events.jsonl",
    contentBase64: fs.readFileSync(identityRelationsPath(roleB)).toString("base64"),
    peerId: "pc-b"
  });
  const account = listIdentityEndpointAccounts(roleA)[0];
  const participant = listIdentityParticipants(roleA)[0];
  assert.equal(account?.conflicted, undefined);
  assert.equal(participant?.conflicted, undefined);
  assert.deepEqual(new Set(participant?.aliases), new Set(["群昵称 A", "群昵称 B"]));
});

test("candidate relation observations keep different conversation scopes as separate cards", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-identity-relation-scope-observe-"));
  observeIdentityEndpoint(roleDir, {
    platform: "napcat", endpointIdentityNamespace: "bot:999", senderStableId: "203", displayName: "讨论者"
  });
  for (const [conversationKey, messageId] of [["napcat:group:a", "m-a"], ["napcat:group:b", "m-b"]] as const) {
    recordIdentityCandidateObservation(roleDir, {
      platform: "napcat",
      endpointIdentityNamespace: "bot:999",
      senderStableId: "203",
      conversationKey,
      evidenceRefs: [{ messageId, conversationKey, note: "对方在当前群说明了协作关系。" }],
      relations: [{ targetKind: "project", targetId: "project-x", relationship: "参与讨论" }]
    });
  }
  const relations = listIdentityRelationCards(roleDir);
  assert.equal(relations.length, 2);
  assert.deepEqual(relations.map(item => item.scope.conversationKeys[0]).sort(), ["napcat:group:a", "napcat:group:b"]);
});

test("automatic candidate learning stops after the endpoint has a confirmed participant", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-identity-confirmed-stop-"));
  const observed = observeIdentityEndpoint(roleDir, {
    platform: "napcat", endpointIdentityNamespace: "bot:999", senderStableId: "204", displayName: "候选"
  });
  updateIdentityRelation(roleDir, {
    kind: "participant", participantId: observed.participantId, participantKind: "person", displayName: "已确认成员",
    aliases: ["候选"], status: "confirmed", evidenceRefs: [{ messageId: "m-confirm" }]
  });
  updateIdentityRelation(roleDir, {
    kind: "endpoint_account", platform: "napcat", endpointIdentityNamespace: "bot:999", senderStableId: "204",
    participantLinks: [{ participantId: observed.participantId!, status: "confirmed", confidence: 1, evidenceRefs: [{ messageId: "m-confirm" }] }]
  });
  assert.throws(() => recordIdentityCandidateObservation(roleDir, {
    platform: "napcat", endpointIdentityNamespace: "bot:999", senderStableId: "204",
    participantDisplayName: "不应继续自动修改", evidenceRefs: [{ messageId: "m-later", note: "后续消息" }]
  }), /confirmed endpoint account/i);
});

test("corrected participants and account links remain authoritative and stop automatic relearning", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-identity-corrected-authority-"));
  updateIdentityRelation(roleDir, {
    kind: "participant", participantId: "participant-corrected", participantKind: "person", displayName: "纠正后的身份",
    aliases: [], status: "corrected", evidenceRefs: [{ messageId: "m-corrected" }]
  });
  updateIdentityRelation(roleDir, {
    kind: "endpoint_account", platform: "napcat", endpointIdentityNamespace: "bot:999", senderStableId: "corrected-user",
    participantLinks: [{ participantId: "participant-corrected", status: "corrected", confidence: 1, evidenceRefs: [{ messageId: "m-corrected" }] }]
  });

  const resolved = resolveIdentityRelationContext(roleDir, {
    platform: "napcat", endpointIdentityNamespace: "bot:999", senderStableId: "corrected-user"
  });
  assert.equal(resolved?.confirmedParticipant?.id, "participant-corrected");
  assert.equal(resolved?.unresolved.length, 0);

  const observed = observeIdentityEndpoint(roleDir, {
    platform: "napcat", endpointIdentityNamespace: "bot:999", senderStableId: "corrected-user", displayName: "新昵称"
  });
  assert.equal(observed.updated, false);
  assert.equal(observed.participantId, "participant-corrected");
  assert.equal(listIdentityParticipants(roleDir).length, 1);
  assert.throws(() => recordIdentityCandidateObservation(roleDir, {
    platform: "napcat", endpointIdentityNamespace: "bot:999", senderStableId: "corrected-user",
    participantDisplayName: "不应继续学习", evidenceRefs: [{ messageId: "m-later" }]
  }), /confirmed endpoint account/i);
});

test("identity writes reject dangling, retired, conflicted, and multiple authoritative participant links", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-identity-reference-validation-"));
  assert.throws(() => updateIdentityRelation(roleDir, {
    kind: "endpoint_account", platform: "napcat", endpointIdentityNamespace: "bot:999", senderStableId: "missing",
    participantLinks: [{ participantId: "participant-missing", status: "confirmed", evidenceRefs: [] }]
  }), /existing identity participant/i);

  for (const [participantId, status] of [["participant-a", "confirmed"], ["participant-b", "corrected"], ["participant-retired", "retired"]] as const) {
    updateIdentityRelation(roleDir, {
      kind: "participant", participantId, participantKind: "person", displayName: participantId,
      aliases: [], status, evidenceRefs: []
    });
  }
  assert.throws(() => updateIdentityRelation(roleDir, {
    kind: "endpoint_account", platform: "napcat", endpointIdentityNamespace: "bot:999", senderStableId: "two-owners",
    participantLinks: [
      { participantId: "participant-a", status: "confirmed", evidenceRefs: [] },
      { participantId: "participant-b", status: "corrected", evidenceRefs: [] }
    ]
  }), /at most one confirmed or corrected/i);
  assert.throws(() => updateIdentityRelation(roleDir, {
    kind: "endpoint_account", platform: "napcat", endpointIdentityNamespace: "bot:999", senderStableId: "retired-owner",
    participantLinks: [{ participantId: "participant-retired", status: "candidate", evidenceRefs: [] }]
  }), /retired identity participant/i);
  assert.throws(() => updateIdentityRelation(roleDir, {
    kind: "relation_card", subjectParticipantId: "participant-missing", targetKind: "project", targetId: "project-x",
    relationship: "参与讨论", status: "candidate", scope: { conversationKeys: [], projectIds: [] }, evidenceRefs: []
  }), /subjectParticipantId must reference an existing/i);
});

test("a retired account link can be observed again without reviving the old identity", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-identity-retired-reobserve-"));
  const first = observeIdentityEndpoint(roleDir, {
    platform: "napcat", endpointIdentityNamespace: "bot:999", senderStableId: "retired-reappears", displayName: "旧候选"
  });
  updateIdentityRelation(roleDir, {
    kind: "participant", participantId: first.participantId, status: "retired"
  });
  updateIdentityRelation(roleDir, {
    kind: "endpoint_account", platform: "napcat", endpointIdentityNamespace: "bot:999", senderStableId: "retired-reappears",
    participantLinks: [{ participantId: first.participantId!, status: "retired", evidenceRefs: [] }]
  });

  const observedAgain = observeIdentityEndpoint(roleDir, {
    platform: "napcat", endpointIdentityNamespace: "bot:999", senderStableId: "retired-reappears", displayName: "重新出现"
  });
  assert.equal(observedAgain.participantCreated, true);
  assert.notEqual(observedAgain.participantId, first.participantId);
  assert.equal(resolveIdentityRelationContext(roleDir, {
    platform: "napcat", endpointIdentityNamespace: "bot:999", senderStableId: "retired-reappears"
  })?.candidateParticipants.length, 1);
});

test("an invalid candidate relation does not partially update the participant", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-identity-observe-validation-"));
  const observed = observeIdentityEndpoint(roleDir, {
    platform: "napcat", endpointIdentityNamespace: "bot:999", senderStableId: "205", displayName: "原称呼"
  });
  assert.throws(() => recordIdentityCandidateObservation(roleDir, {
    platform: "napcat", endpointIdentityNamespace: "bot:999", senderStableId: "205",
    participantDisplayName: "不应写入",
    evidenceRefs: [{ messageId: "m-invalid", note: "包含无效关系" }],
    relations: [{ targetKind: "invalid" as any, targetId: "x", relationship: "无效" }]
  }), /target kind/i);
  assert.equal(listIdentityParticipants(roleDir).find(item => item.id === observed.participantId)?.displayName, "原称呼");
});

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

test("a shared endpoint account can belong to several known people without becoming a false unique identity", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-identity-shared-account-"));
  for (const [participantId, displayName] of [["participant-liu", "刘云云"], ["participant-zhu", "猪皮糕糕"]] as const) {
    updateIdentityRelation(roleDir, {
      kind: "participant",
      participantId,
      participantKind: "person",
      displayName,
      status: "confirmed",
      aliases: [],
      evidenceRefs: []
    });
  }
  assert.throws(() => updateIdentityRelation(roleDir, {
    kind: "participant",
    participantId: "participant-liu",
    speakingHabits: [{ dimension: "sentence_opening", description: "常从结论开始", evidenceRefs: [] }]
  }), /confirmed-author messageId/);
  updateIdentityRelation(roleDir, {
    kind: "participant",
    participantId: "participant-liu",
    speakingHabits: [{
      dimension: "sentence_opening",
      description: "常从结论开始",
      confidence: 0.8,
      evidenceRefs: [{ messageId: "confirmed-liu-message" }]
    }]
  });
  updateIdentityRelation(roleDir, {
    kind: "endpoint_account",
    platform: "napcat",
    endpointIdentityNamespace: "bot:qa",
    senderStableId: "shared-qq",
    displayName: "lovegd",
    participantLinks: [
      { participantId: "participant-liu", status: "candidate", confidence: 0.5, evidenceRefs: [{ note: "公司 QA 共用账号。" }] },
      { participantId: "participant-zhu", status: "candidate", confidence: 0.5, evidenceRefs: [{ note: "公司 QA 共用账号。" }] }
    ]
  });

  const lookup = { platform: "napcat", endpointIdentityNamespace: "bot:qa", senderStableId: "shared-qq" };
  const context = resolveIdentityRelationContext(roleDir, lookup);
  assert.equal(context?.confirmedParticipant, undefined);
  assert.deepEqual(context?.possibleParticipants.map(item => item.participant.displayName), ["刘云云", "猪皮糕糕"]);
  assert.equal(context?.possibleParticipants[0]?.participant.speakingHabits?.[0]?.dimension, "sentence_opening");
  assert.deepEqual(context?.candidateParticipants, []);
  assert.match(context?.unresolved.join("\n") ?? "", /结合本次对话另行判断/);

  const participantCount = listIdentityParticipants(roleDir).length;
  const observation = observeIdentityEndpoint(roleDir, { ...lookup, displayName: "QA 共用账号" });
  assert.equal(observation.updated, false);
  assert.equal(listIdentityParticipants(roleDir).length, participantCount);
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
