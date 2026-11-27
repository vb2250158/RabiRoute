import assert from "node:assert/strict";
import test from "node:test";
import { localeOptions } from "../src/i18n/index";
import { lanAgentTaskMessage, lanAgentTaskStatus, recentTaskCopy } from "../src/i18n/lanAgentTasks";

test("recent LAN Agent tasks have labels for each registry status in every locale", () => {
  const statuses = ["queued", "delivered", "acknowledged", "progress", "completed", "failed", "interrupted"];
  for (const { locale } of localeOptions) {
    for (const status of statuses) assert.notEqual(lanAgentTaskStatus(status, locale), status);
    assert.equal(lanAgentTaskStatus("future-status", locale), "future-status");
    assert.ok(recentTaskCopy[locale].empty);
  }
});

test("stored connector messages translate while diagnostic details and unfamiliar results stay readable", () => {
  const busy = "The selected Codex task is busy. Wait for its current task to finish before submitting another message.";
  const accepted = "Codex Desktop accepted the task. Rabi Agent is waiting for its task state.";
  const ipc = "Codex Desktop IPC thread-follower-start-turn failed: no-client-found";
  const otherIpc = "Codex Desktop IPC thread-follower-start-turn failed: thread-follower-start-turn-timeout";
  assert.match(lanAgentTaskMessage(busy, "zh-CN"), /会话正忙/);
  assert.match(lanAgentTaskMessage(accepted, "ja"), /ステータスの更新/);
  assert.match(lanAgentTaskMessage(ipc, "zh-CN"), /未找到会话客户端（no-client-found）/);
  assert.match(lanAgentTaskMessage(otherIpc, "ja"), /開始できませんでした：thread-follower-start-turn-timeout$/);
  const workspace = "Rabi Agent task workspace is outside the declared allowed workspaces: /example/project";
  assert.equal(lanAgentTaskMessage(workspace, "zh-CN"), "任务工作目录不在 Rabi Agent 允许的范围内：/example/project");
  assert.equal(lanAgentTaskMessage(busy, "en"), busy);
  for (const { locale } of localeOptions) {
    assert.equal(lanAgentTaskMessage("已完成", locale), "已完成");
    assert.equal(lanAgentTaskMessage("—", locale), "—");
  }
});
