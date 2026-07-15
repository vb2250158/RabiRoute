import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  appendRabiLinkConversationEntry,
  readRabiLinkConversationArchiveIndex,
  readRabiLinkConversationEntries,
  readRabiLinkConversationTimeline,
  rabiLinkConversationArchiveDir,
  rabiLinkConversationArchiveIndexPath,
  rabiLinkConversationLedgerPath
} from "./rabilinkConversationLedger.js";

test("RabiLink user observations and Agent deliveries share one ordered JSONL ledger", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-rabilink-ledger-"));
  const user = appendRabiLinkConversationEntry(dataDir, {
    entryId: "rabilink-user:segment-1",
    recordedAt: "2026-07-13T10:00:00.000Z",
    direction: "user_to_agent",
    kind: "voice_transcript",
    text: "用户的一段观察记录",
    requiresReview: true
  });
  const agent = appendRabiLinkConversationEntry(dataDir, {
    entryId: "rabilink-agent:delivery-1",
    recordedAt: "2026-07-13T10:00:02.000Z",
    direction: "agent_to_user",
    kind: "agent_message",
    text: "Agent 已经投递到眼镜的消息",
    deliveryId: "delivery-1",
    targetDeviceKinds: ["glasses"],
    presentation: ["text", "tts"],
    priority: "urgent",
    proactive: true,
    final: true
  });
  const duplicate = appendRabiLinkConversationEntry(dataDir, {
    entryId: "rabilink-user:segment-1",
    recordedAt: "2026-07-13T10:00:00.000Z",
    direction: "user_to_agent",
    kind: "voice_transcript",
    text: "用户的一段观察记录",
    requiresReview: true
  });

  assert.equal(user.appended, true);
  assert.equal(agent.appended, true);
  assert.equal(duplicate.appended, false);
  assert.deepEqual(
    readRabiLinkConversationEntries(dataDir).map((entry) => [entry.direction, entry.text]),
    [
      ["user_to_agent", "用户的一段观察记录"],
      ["agent_to_user", "Agent 已经投递到眼镜的消息"]
    ]
  );
  assert.equal(fs.existsSync(rabiLinkConversationLedgerPath(dataDir)), true);
  assert.deepEqual(agent.entry.targetDeviceKinds, ["glasses"]);
  assert.deepEqual(agent.entry.presentation, ["text", "tts"]);
  assert.equal(agent.entry.priority, "urgent");
});

test("RabiLink conversation ledger mechanically archives an old session by date without summaries", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-rabilink-ledger-archive-"));
  const splitAfterMs = 2 * 60 * 60 * 1000;
  appendRabiLinkConversationEntry(dataDir, {
    entryId: "rabilink-user:old-1",
    recordedAt: "2026-07-13T08:00:00.000Z",
    direction: "user_to_agent",
    kind: "voice_transcript",
    text: "旧会话用户消息",
    requiresReview: true
  }, { splitAfterMs });
  appendRabiLinkConversationEntry(dataDir, {
    entryId: "rabilink-agent:old-2",
    recordedAt: "2026-07-13T08:01:00.000Z",
    direction: "agent_to_user",
    kind: "agent_message",
    text: "旧会话 Agent 消息"
  }, { splitAfterMs });
  const rotated = appendRabiLinkConversationEntry(dataDir, {
    entryId: "rabilink-user:new-1",
    recordedAt: "2026-07-13T11:00:00.000Z",
    direction: "user_to_agent",
    kind: "voice_transcript",
    text: "新会话用户消息",
    requiresReview: true
  }, { splitAfterMs });

  assert.match(path.basename(rotated.archivedPath || ""), /^2026-07-13(?:-\d{2})?\.jsonl$/);
  assert.deepEqual(readRabiLinkConversationEntries(dataDir).map((entry) => entry.entryId), ["rabilink-user:new-1"]);
  const index = readRabiLinkConversationArchiveIndex(dataDir);
  assert.equal(index.sessions.length, 1);
  assert.equal(index.sessions[0]?.entryCount, 2);
  assert.equal(Object.hasOwn(index.sessions[0] || {}, "summary"), false);
  const archivedEntries = fs.readFileSync(path.join(rabiLinkConversationArchiveDir(dataDir), index.sessions[0].file), "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.deepEqual(archivedEntries.map((entry) => entry.entryId), ["rabilink-user:old-1", "rabilink-agent:old-2"]);

  const retriedOldEntry = appendRabiLinkConversationEntry(dataDir, {
    entryId: "rabilink-user:old-1",
    recordedAt: "2026-07-13T08:00:00.000Z",
    direction: "user_to_agent",
    kind: "voice_transcript",
    text: "旧会话用户消息",
    requiresReview: true
  }, { splitAfterMs });
  assert.equal(retriedOldEntry.appended, false);
  assert.deepEqual(readRabiLinkConversationEntries(dataDir).map((entry) => entry.entryId), ["rabilink-user:new-1"]);
  assert.equal(
    fs.readdirSync(rabiLinkConversationArchiveDir(dataDir)).some((file) => file.endsWith(".tmp")),
    false,
    "archive index replacement must not leave temporary files behind"
  );
});

test("RabiLink conversation timeline recovers an orphaned archive when its index is missing or corrupt", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-rabilink-ledger-orphan-"));
  const archiveDir = rabiLinkConversationArchiveDir(dataDir);
  fs.mkdirSync(archiveDir, { recursive: true });
  const archivedPath = path.join(archiveDir, "2026-07-12.jsonl");
  fs.writeFileSync(archivedPath, [
    JSON.stringify({
      schemaVersion: 1,
      entryId: "rabilink-user:orphaned-observation",
      recordedAt: "2026-07-12T10:00:00.000Z",
      time: 1783850400,
      direction: "user_to_agent",
      kind: "voice_transcript",
      channel: "rabilink",
      text: "分卷完成但索引写入前进程退出的观察记录",
      requiresReview: true
    }),
    JSON.stringify({
      schemaVersion: 1,
      entryId: "rabilink-agent:orphaned-delivery",
      recordedAt: "2026-07-12T10:01:00.000Z",
      time: 1783850460,
      direction: "agent_to_user",
      kind: "agent_message",
      channel: "rabilink",
      text: "同一分卷中的 Agent 投递",
      proactive: true
    }),
    ""
  ].join("\n"), "utf8");
  fs.writeFileSync(rabiLinkConversationArchiveIndexPath(dataDir), "{corrupt", "utf8");

  const recoveredIndex = readRabiLinkConversationArchiveIndex(dataDir);
  assert.deepEqual(recoveredIndex.sessions, [{
    file: "2026-07-12.jsonl",
    startedAt: "2026-07-12T10:00:00.000Z",
    endedAt: "2026-07-12T10:01:00.000Z",
    entryCount: 2
  }]);
  assert.deepEqual(
    readRabiLinkConversationTimeline(dataDir).map((entry) => entry.entryId),
    ["rabilink-user:orphaned-observation", "rabilink-agent:orphaned-delivery"]
  );

  const duplicate = appendRabiLinkConversationEntry(dataDir, {
    entryId: "rabilink-user:orphaned-observation",
    recordedAt: "2026-07-12T10:00:00.000Z",
    direction: "user_to_agent",
    kind: "voice_transcript",
    text: "分卷完成但索引写入前进程退出的观察记录",
    requiresReview: true
  });
  assert.equal(duplicate.appended, false);
  assert.equal(fs.existsSync(rabiLinkConversationLedgerPath(dataDir)), false);
});

test("RabiLink archive index replacement remains complete across repeated rotations", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-rabilink-ledger-repeated-"));
  const splitAfterMs = 2 * 60 * 60 * 1000;
  for (const [entryId, recordedAt] of [
    ["rabilink-user:session-a", "2026-07-13T08:00:00.000Z"],
    ["rabilink-user:session-b", "2026-07-13T11:00:00.000Z"],
    ["rabilink-user:session-c", "2026-07-13T14:00:00.000Z"]
  ]) {
    appendRabiLinkConversationEntry(dataDir, {
      entryId,
      recordedAt,
      direction: "user_to_agent",
      kind: "voice_transcript",
      text: entryId,
      requiresReview: true
    }, { splitAfterMs });
  }

  assert.deepEqual(
    readRabiLinkConversationArchiveIndex(dataDir).sessions.map((item) => item.file),
    ["2026-07-13.jsonl", "2026-07-13-02.jsonl"]
  );
  assert.deepEqual(
    readRabiLinkConversationTimeline(dataDir).map((entry) => entry.entryId),
    ["rabilink-user:session-a", "rabilink-user:session-b", "rabilink-user:session-c"]
  );
  assert.equal(
    fs.readdirSync(rabiLinkConversationArchiveDir(dataDir)).some((file) => file.endsWith(".tmp")),
    false
  );
});

test("RabiLink conversation appends respect the cross-process rotation lock", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-rabilink-ledger-lock-"));
  const lockPath = path.join(dataDir, ".rabilink-conversation.lock");
  fs.writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`, "utf8");
  const releaser = spawn(process.execPath, [
    "-e",
    "const fs=require('node:fs'); setTimeout(() => { try { fs.unlinkSync(process.env.LOCK_PATH); } catch {} }, 180);"
  ], {
    env: { ...process.env, LOCK_PATH: lockPath },
    stdio: "ignore"
  });

  const startedAt = Date.now();
  appendRabiLinkConversationEntry(dataDir, {
    entryId: "rabilink-user:locked-append",
    recordedAt: "2026-07-13T10:00:00.000Z",
    direction: "user_to_agent",
    kind: "voice_transcript",
    text: "等待另一个进程完成分卷后再写入",
    requiresReview: true
  });
  const elapsedMs = Date.now() - startedAt;
  await new Promise<void>((resolve, reject) => {
    releaser.once("exit", () => resolve());
    releaser.once("error", reject);
  });

  assert(elapsedMs >= 120, `append ignored the cross-process lock (${elapsedMs}ms)`);
  assert.deepEqual(readRabiLinkConversationEntries(dataDir).map((entry) => entry.entryId), ["rabilink-user:locked-append"]);
});
