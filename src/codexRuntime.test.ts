import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  buildCodexBootstrapEnv,
  codexThreadDiscoveryRequestForTest,
  ensureCodexDesktopDeliveryMarkerForTest,
  codexThreadIsActiveFromSourcesForTest,
  codexThreadRuntimeStatusFromSourcesForTest,
  codexThreadDeliveryTargetIsStaleForTest,
  codexThreadMatchesConfiguredTargetForTest,
  mergeCodexDesktopThreadsWithMetadataForTest,
  listCodexThreads,
  resolvePrimaryCodexTurnOptions,
  waitForCodexDesktopThreadForTest
} from "./codexRuntime.js";

test("every Desktop delivery has one stable UUID receipt marker", () => {
  const requestedId = "12345678-1234-4567-8123-123456789abc";
  const prepared = ensureCodexDesktopDeliveryMarkerForTest("通知目标任务", requestedId);
  assert.equal(prepared.deliveryId, requestedId);
  assert.match(prepared.prompt, /\[投递编号\]\ndeliveryId: 12345678-1234-4567-8123-123456789abc$/);

  const existing = ensureCodexDesktopDeliveryMarkerForTest(
    "[Agent 回复合同]\n本次投递 deliveryId：aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    requestedId
  );
  assert.equal(existing.deliveryId, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  assert.equal(existing.prompt.match(/deliveryId/g)?.length, 1);
});

test("Primary Codex turns apply the Route model and reasoning effort together", () => {
  assert.deepEqual(resolvePrimaryCodexTurnOptions({
    agentModel: " gpt-5.6-terra ",
    agentReasoningEffort: "high"
  }), {
    model: "gpt-5.6-terra",
    reasoningEffort: "high"
  });
  assert.deepEqual(resolvePrimaryCodexTurnOptions({ agentModel: "" }), {});
});

test("durable rollout completion clears an older Desktop IPC active marker", () => {
  assert.equal(codexThreadIsActiveFromSourcesForTest(100, {
    state: "inactive",
    observedAtMs: 200
  }), false);
  assert.equal(codexThreadIsActiveFromSourcesForTest(300, {
    state: "inactive",
    observedAtMs: 200
  }), true);
  assert.equal(codexThreadIsActiveFromSourcesForTest(null, {
    state: "active",
    observedAtMs: 200
  }), true);
});

test("Codex task runtime status comes from the live Desktop host plus Codex rollout state", () => {
  assert.equal(codexThreadRuntimeStatusFromSourcesForTest(false, null, {
    state: "active",
    observedAtMs: 200
  }), "unavailable");
  assert.equal(codexThreadRuntimeStatusFromSourcesForTest(true, null, {
    state: "active",
    observedAtMs: 200
  }), "active");
  assert.equal(codexThreadRuntimeStatusFromSourcesForTest(true, null, {
    state: "inactive",
    observedAtMs: 200
  }), "idle");
  assert.equal(codexThreadRuntimeStatusFromSourcesForTest(true, null, {
    state: "unknown",
    observedAtMs: 0
  }), "notLoaded");
});

test("system-owned Desktop task discovery can use the bounded app-server state index", () => {
  const search = codexThreadDiscoveryRequestForTest("星海 协助处理消息1", null, ["C:/Projects/PangHu"], true);
  assert.equal(search.method, "thread/list");
  assert.equal(search.params.searchTerm, "星海 协助处理消息1");
  assert.equal(search.params.useStateDbOnly, true);
  assert.deepEqual(search.params.cwd, ["C:/Projects/PangHu"]);

  const list = codexThreadDiscoveryRequestForTest("", "next-page", ["C:/Projects/PangHu"]);
  assert.equal(list.method, "thread/list");
  assert.equal(list.params.searchTerm, undefined);
  assert.equal(list.params.useStateDbOnly, false);
  assert.deepEqual(list.params.cwd, ["C:/Projects/PangHu"]);
  assert.equal(list.params.cursor, "next-page");
});

test("Codex task bootstrap cannot inherit a stale desktop WebSocket override", () => {
  const env = buildCodexBootstrapEnv({
    Path: "C:\\Windows",
    CODEX_APP_SERVER_WS_URL: "ws://127.0.0.1:4510",
    KEEP_ME: "yes"
  }, "C:\\Program Files\\nodejs\\node.exe", ";");

  assert.equal(env.CODEX_APP_SERVER_WS_URL, undefined);
  assert.equal(env.KEEP_ME, "yes");
  assert.equal(env.Path, "C:\\Program Files\\nodejs;C:\\Windows");
});

test("Codex Desktop treats thread name plus cwd as the delivery target", () => {
  const currentCwd = path.resolve("C:/Projects/RabiRoute");

  assert.equal(
    codexThreadMatchesConfiguredTargetForTest({ name: "Rabi", cwd: currentCwd }, "Rabi", currentCwd),
    true
  );
  assert.equal(
    codexThreadMatchesConfiguredTargetForTest({ name: "Rabi", cwd: "D:/Projects/RabiRoute" }, "Rabi", currentCwd),
    false
  );
  assert.equal(
    codexThreadMatchesConfiguredTargetForTest({ name: "别的会话", cwd: currentCwd }, "Rabi", currentCwd),
    false
  );
});

test("Codex Desktop treats archived rollout errors as stale delivery targets", () => {
  assert.equal(
    codexThreadDeliveryTargetIsStaleForTest(new Error('{"code":-32600,"message":"no rollout found for thread id 019f481b-7b3d-7671-a362-bc915ff2a250"}')),
    true
  );
  assert.equal(codexThreadDeliveryTargetIsStaleForTest(new Error("thread not found")), true);
  assert.equal(codexThreadDeliveryTargetIsStaleForTest(new Error("model temporarily unavailable")), false);
});

test("Codex task discovery uses the app-server user-facing name instead of mutable SQLite title", () => {
  const result = mergeCodexDesktopThreadsWithMetadataForTest([{
    id: "019f0000-0000-7000-8000-000000000049",
    title: "[RabiRoute 事件] 首条超长消息",
    cwd: "D:/MonsterGirl",
    updatedAt: "2026-07-18T03:00:00.000Z",
    rolloutPath: "session.jsonl",
    firstUserMessage: "[RabiRoute 事件] 首条超长消息"
  }], [{
    id: "019f0000-0000-7000-8000-000000000049",
    name: "MonsterGirl / 伊莉娅 策划美术",
    cwd: "D:\\MonsterGirl",
    updatedAt: 1_784_359_692
  }], {
    query: "MonsterGirl / 伊莉娅 策划美术",
    allowedWorkspaces: ["//?/D:/MonsterGirl"],
    limit: 20,
    offset: 0
  });

  assert.equal(result.length, 1);
  assert.equal(result[0]?.title, "MonsterGirl / 伊莉娅 策划美术");
  assert.equal(result[0]?.id, "019f0000-0000-7000-8000-000000000049");
  assert.equal(result[0]?.updatedAt, "2026-07-18T07:28:12.000Z");
});

test("freshly created Desktop tasks wait for the read index before first delivery", async () => {
  const expected = {
    id: "019f0000-0000-7000-8000-000000000041",
    title: "新任务",
    cwd: process.cwd(),
    updatedAt: "2026-07-16T00:00:00Z",
    rolloutPath: "new.jsonl",
    firstUserMessage: ""
  };
  let readCount = 0;
  let waitCount = 0;

  const actual = await waitForCodexDesktopThreadForTest({
    threadId: expected.id,
    cwd: expected.cwd,
    attempts: 3,
    delayMs: 1
  }, {
    read: () => (++readCount < 3 ? null : expected),
    wait: async () => { waitCount += 1; }
  });

  assert.equal(actual.id, expected.id);
  assert.equal(readCount, 3);
  assert.equal(waitCount, 2);
});

test("local state lookup finds a bootstrapped task before it has a first message", async (t) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-empty-bootstrap-"));
  const previousCodexHome = process.env.CODEX_HOME;
  t.after(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(codexHome, { recursive: true, force: true });
  });
  process.env.CODEX_HOME = codexHome;

  const database = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
  database.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      title TEXT,
      cwd TEXT,
      rollout_path TEXT,
      updated_at INTEGER,
      updated_at_ms INTEGER,
      recency_at INTEGER,
      recency_at_ms INTEGER,
      archived INTEGER,
      first_user_message TEXT
    );
  `);
  const taskId = "019f0000-0000-7000-8000-000000000073";
  const taskTitle = "[PangHu][Bug] 摆放系统 - 建筑或物件位置重叠";
  database.prepare(`
    INSERT INTO threads (
      id, title, cwd, rollout_path, updated_at, updated_at_ms,
      recency_at, recency_at_ms, archived, first_user_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    taskId,
    taskTitle,
    process.cwd(),
    path.join(codexHome, "empty-rollout.jsonl"),
    1_786_451_763,
    1_786_451_763_866,
    1_786_451_746,
    1_786_451_746_925,
    0,
    ""
  );
  database.close();

  const result = await listCodexThreads({
    query: taskTitle,
    limit: 20,
    offset: 0,
    allowedWorkspaces: [process.cwd()],
    stateDbOnly: true
  });

  assert.equal(result.length, 1);
  assert.equal(result[0]?.id, taskId);
  assert.equal(result[0]?.title, taskTitle);
});
