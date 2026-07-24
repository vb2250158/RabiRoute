import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendMessageContextToDir } from "./messageContextStore.js";
import {
  findPersonaVoiceIdentity,
  listPersonaVoiceIdentities,
  personaVoiceIdentitiesPath,
  resolvePersonaVoiceIdentities,
  updatePersonaVoiceIdentity
} from "./personaVoiceIdentities.js";
import { PersonaSyncService } from "./personaSync.js";
import { listPersonaVoiceTranscriptViews } from "./personaVoiceTranscriptView.js";

test("persona voice identities are scoped by processing host and remain merge-friendly JSONL", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-voice-identities-"));
  const first = updatePersonaVoiceIdentity(roleDir, {
    sourceHostId: "host-a",
    sourceHostName: "Studio PC",
    voiceprintId: "cluster-1",
    displayName: "老板",
    relationship: "我的用户",
    isUser: true,
    aliases: ["老板", "你"],
    notes: "由当前人格根据对话确认"
  });
  const otherHost = updatePersonaVoiceIdentity(roleDir, {
    sourceHostId: "host-b",
    voiceprintId: "cluster-1",
    displayName: "访客",
    isUser: false,
    aliases: []
  });
  const unchanged = updatePersonaVoiceIdentity(roleDir, {
    sourceHostId: "host-a",
    sourceHostName: "Studio PC",
    voiceprintId: "cluster-1",
    displayName: "老板",
    relationship: "我的用户",
    isUser: true,
    aliases: ["老板", "你"],
    notes: "由当前人格根据对话确认"
  });

  assert.equal(first.appended, true);
  assert.equal(otherHost.appended, true);
  assert.equal(unchanged.appended, false);
  assert.equal(listPersonaVoiceIdentities(roleDir).length, 2);
  assert.equal(findPersonaVoiceIdentity(roleDir, "host-a", "cluster-1")?.isUser, true);
  assert.equal(findPersonaVoiceIdentity(roleDir, "host-b", "cluster-1")?.displayName, "访客");
  assert.deepEqual(
    resolvePersonaVoiceIdentities(roleDir, "host-a", ["cluster-1", "cluster-missing"])
      .map(item => [item.voiceprintId, item.identity?.displayName]),
    [["cluster-1", "老板"], ["cluster-missing", undefined]]
  );
  assert.equal(fs.readFileSync(personaVoiceIdentitiesPath(roleDir), "utf8").trim().split(/\r?\n/).length, 2);
});

test("persona voice identities clear only the persona decision while preserving the relationship", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-voice-identities-clear-"));
  updatePersonaVoiceIdentity(roleDir, {
    sourceHostId: "host-a",
    sourceHostName: "Studio PC",
    voiceprintId: "voice-a",
    displayName: "我的用户",
    relationship: "主人",
    isUser: true,
    aliases: []
  });
  const cleared = updatePersonaVoiceIdentity(roleDir, {
    sourceHostId: "host-a",
    voiceprintId: "voice-a",
    isUser: null
  });

  assert.equal(cleared.appended, true);
  assert.equal(cleared.identity?.isUser, undefined);
  assert.equal(cleared.identity?.displayName, "我的用户");
  assert.equal(cleared.identity?.relationship, "主人");
  assert.equal(cleared.identity?.sourceHostName, "Studio PC");
  assert.equal(fs.readFileSync(personaVoiceIdentitiesPath(roleDir), "utf8").trim().split(/\r?\n/).length, 2);
});

test("persona voice identities use tombstone events instead of rewriting shared history", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-voice-identities-delete-"));
  updatePersonaVoiceIdentity(roleDir, {
    sourceHostId: "host-a",
    voiceprintId: "voice-a",
    displayName: "待确认",
    aliases: []
  });
  const removed = updatePersonaVoiceIdentity(roleDir, {
    sourceHostId: "host-a",
    voiceprintId: "voice-a",
    deleted: true
  });

  assert.equal(removed.deleted, true);
  assert.equal(listPersonaVoiceIdentities(roleDir).length, 0);
  assert.equal(fs.readFileSync(personaVoiceIdentitiesPath(roleDir), "utf8").trim().split(/\r?\n/).length, 2);
});

test("persona voice identities keep legacy row-order history readable and attach lineage on the next update", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-voice-identities-legacy-"));
  updatePersonaVoiceIdentity(roleDir, {
    sourceHostId: "legacy-host",
    voiceprintId: "legacy-cluster",
    displayName: "旧称呼",
    isUser: true,
    aliases: []
  });
  updatePersonaVoiceIdentity(roleDir, {
    sourceHostId: "legacy-host",
    voiceprintId: "legacy-cluster",
    displayName: "后来称呼",
    isUser: false,
    aliases: []
  });
  const filePath = personaVoiceIdentitiesPath(roleDir);
  const legacyRows = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/).map(line => {
    const row = JSON.parse(line);
    delete row.supersedes;
    return row;
  });
  fs.writeFileSync(filePath, `${legacyRows.map(row => JSON.stringify(row)).join("\n")}\n`, "utf8");

  const legacy = findPersonaVoiceIdentity(roleDir, "legacy-host", "legacy-cluster");
  assert.equal(legacy?.displayName, "后来称呼");
  assert.equal(legacy?.isUser, false);
  assert.equal(legacy?.conflicted, undefined);

  updatePersonaVoiceIdentity(roleDir, {
    sourceHostId: "legacy-host",
    voiceprintId: "legacy-cluster",
    displayName: "最终称呼",
    isUser: true,
    aliases: []
  });
  const rows = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.deepEqual(rows.at(-1)?.supersedes, [legacyRows.at(-1)?.id]);
  assert.equal(findPersonaVoiceIdentity(roleDir, "legacy-host", "legacy-cluster")?.displayName, "最终称呼");
});

test("persona voice identities preserve concurrent PC branches until the persona explicitly resolves them", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-voice-identity-branches-"));
  const rolesA = path.join(root, "pc-a", "roles");
  const rolesB = path.join(root, "pc-b", "roles");
  const roleA = path.join(rolesA, "Rabi");
  const roleB = path.join(rolesB, "Rabi");
  updatePersonaVoiceIdentity(roleA, {
    sourceHostId: "host-audio",
    voiceprintId: "cluster-user",
    displayName: "待确认",
    aliases: []
  });
  fs.mkdirSync(path.dirname(personaVoiceIdentitiesPath(roleB)), { recursive: true });
  fs.copyFileSync(personaVoiceIdentitiesPath(roleA), personaVoiceIdentitiesPath(roleB));

  updatePersonaVoiceIdentity(roleA, {
    sourceHostId: "host-audio",
    voiceprintId: "cluster-user",
    displayName: "老板",
    relationship: "当前人格的用户",
    isUser: true,
    aliases: ["老板"]
  });
  updatePersonaVoiceIdentity(roleB, {
    sourceHostId: "host-audio",
    voiceprintId: "cluster-user",
    displayName: "访客",
    relationship: "来访者",
    isUser: false,
    aliases: ["客人"]
  });

  const syncA = new PersonaSyncService(() => rolesA, path.join(root, "pc-a", "sync"));
  const remote = fs.readFileSync(personaVoiceIdentitiesPath(roleB));
  assert.equal(syncA.merge({
    roleId: "Rabi",
    path: "voice/voice-identities.jsonl",
    contentBase64: remote.toString("base64"),
    peerId: "pc-b"
  }).status, "merged");

  const conflicted = findPersonaVoiceIdentity(roleA, "host-audio", "cluster-user");
  assert.equal(conflicted?.conflicted, true);
  assert.deepEqual(conflicted?.conflictFields?.sort(), ["aliases", "displayName", "isUser", "relationship"]);
  assert.equal(conflicted?.isUser, undefined);
  assert.equal(conflicted?.conflictCandidates?.length, 2);
  appendMessageContextToDir(roleA, {
    time: Date.UTC(2026, 6, 23, 12, 0, 0) / 1_000,
    direction: "inbound",
    adapter: "speech",
    kind: "asr",
    sourceHostId: "host-audio",
    messageId: "conflicted-voice",
    text: "这句话是谁说的？",
    segments: [{
      id: 0,
      start: 0,
      end: 1,
      text: "这句话是谁说的？",
      voiceprintId: "cluster-user"
    }]
  }, { archiveCheck: false });
  assert.equal(listPersonaVoiceTranscriptViews(roleA, { limit: 10 })[0]?.personaClassification, "conflict");

  const resolved = updatePersonaVoiceIdentity(roleA, {
    sourceHostId: "host-audio",
    voiceprintId: "cluster-user",
    displayName: "老板",
    relationship: "当前人格的用户",
    isUser: true,
    aliases: ["老板"]
  });
  assert.equal(resolved.appended, true);
  assert.equal(resolved.identity?.conflicted, undefined);
  assert.equal(resolved.identity?.isUser, true);
  assert.equal(listPersonaVoiceTranscriptViews(roleA, { limit: 10 })[0]?.personaClassification, "user");
  const rows = fs.readFileSync(personaVoiceIdentitiesPath(roleA), "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(rows.at(-1)?.supersedes.length, 2);

  const syncB = new PersonaSyncService(() => rolesB, path.join(root, "pc-b", "sync"));
  const resolvedContent = fs.readFileSync(personaVoiceIdentitiesPath(roleA));
  assert.equal(syncB.merge({
    roleId: "Rabi",
    path: "voice/voice-identities.jsonl",
    contentBase64: resolvedContent.toString("base64"),
    peerId: "pc-a"
  }).status, "merged");
  assert.equal(findPersonaVoiceIdentity(roleB, "host-audio", "cluster-user")?.isUser, true);
  assert.equal(findPersonaVoiceIdentity(roleB, "host-audio", "cluster-user")?.conflicted, undefined);
});

test("persona voice identities treat concurrent deletion and retention as an explicit conflict", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-voice-identity-delete-branch-"));
  const rolesA = path.join(root, "pc-a", "roles");
  const rolesB = path.join(root, "pc-b", "roles");
  const roleA = path.join(rolesA, "Rabi");
  const roleB = path.join(rolesB, "Rabi");
  updatePersonaVoiceIdentity(roleA, {
    sourceHostId: "host-audio",
    voiceprintId: "cluster-delete",
    displayName: "用户",
    isUser: true,
    aliases: []
  });
  fs.mkdirSync(path.dirname(personaVoiceIdentitiesPath(roleB)), { recursive: true });
  fs.copyFileSync(personaVoiceIdentitiesPath(roleA), personaVoiceIdentitiesPath(roleB));
  updatePersonaVoiceIdentity(roleA, {
    sourceHostId: "host-audio",
    voiceprintId: "cluster-delete",
    deleted: true
  });
  updatePersonaVoiceIdentity(roleB, {
    sourceHostId: "host-audio",
    voiceprintId: "cluster-delete",
    displayName: "仍然保留",
    isUser: true,
    aliases: []
  });

  const syncA = new PersonaSyncService(() => rolesA, path.join(root, "pc-a", "sync"));
  const remote = fs.readFileSync(personaVoiceIdentitiesPath(roleB));
  syncA.merge({
    roleId: "Rabi",
    path: "voice/voice-identities.jsonl",
    contentBase64: remote.toString("base64"),
    peerId: "pc-b"
  });
  const conflicted = findPersonaVoiceIdentity(roleA, "host-audio", "cluster-delete");
  assert.equal(conflicted?.conflicted, true);
  assert.deepEqual(conflicted?.conflictFields, ["deleted"]);
  assert.equal(conflicted?.isUser, undefined);
  assert.deepEqual(conflicted?.conflictCandidates?.map(candidate => candidate.deleted).sort(), [false, true]);

  assert.equal(updatePersonaVoiceIdentity(roleA, {
    sourceHostId: "host-audio",
    voiceprintId: "cluster-delete",
    deleted: true
  }).appended, true);
  assert.equal(findPersonaVoiceIdentity(roleA, "host-audio", "cluster-delete"), undefined);
});
