import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RabiContextManager, requiredReadContextKey } from "./rabiContextManager.js";

function fixture(): { root: string; roleDir: string; memoryPath: string; completedPlanPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-context-manager-"));
  const roleDir = path.join(root, "roles", "YeYu");
  const activePlansDir = path.join(roleDir, "plans", "items", "active");
  const memoryDir = path.join(roleDir, "memory", "recent");
  fs.mkdirSync(activePlansDir, { recursive: true });
  fs.mkdirSync(memoryDir, { recursive: true });
  const oldTimestamp = "2020-01-01T00:00:00.000Z";
  const currentTimestamp = new Date().toISOString();
  const completedPlanPath = path.join(activePlansDir, "plan-complete.json");
  const memoryPath = path.join(memoryDir, "memory-hook.json");
  fs.writeFileSync(completedPlanPath, JSON.stringify({
    id: "plan-complete",
    title: "已完成旧计划",
    focus: "已完成旧计划",
    status: "已完成",
    currentStep: "完成",
    nextAction: "归档",
    steps: [],
    createdAt: oldTimestamp,
    updatedAt: oldTimestamp,
    completedAt: oldTimestamp,
    keywords: ["旧计划"]
  }, null, 2), "utf8");
  fs.writeFileSync(memoryPath, JSON.stringify({
    id: "memory-hook",
    title: "Hook 触发与注入",
    focus: "Hook 触发与注入",
    content: "上下文由 Rabi PC Manager 统一管理。",
    createdAt: currentTimestamp,
    updatedAt: currentTimestamp,
    keywords: ["统一管理"]
  }, null, 2), "utf8");
  return { root, roleDir, memoryPath, completedPlanPath };
}

test("preview resolves the same indexes without lifecycle side effects", (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const resolution = new RabiContextManager().resolve({
    kind: "preview",
    source: "manager_api",
    roleId: "YeYu",
    roleDir: data.roleDir,
    signalText: "统一管理"
  });
  assert.equal(resolution.shouldInject, true);
  assert.equal(resolution.knowledge.requiredReadItems[0]?.id, "memory-hook");
  assert.equal(JSON.parse(fs.readFileSync(data.memoryPath, "utf8")).viewedAt, undefined);
  assert.equal(fs.existsSync(data.completedPlanPath), true);
});

test("message delivery performs the normal viewedAt and archive lifecycle", (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const resolution = new RabiContextManager().resolve({
    kind: "message_delivery",
    source: "rabi_delivery",
    roleId: "YeYu",
    roleDir: data.roleDir,
    signalText: "统一管理"
  });
  assert.equal(resolution.knowledge.requiredReadItems[0]?.id, "memory-hook");
  assert.equal(typeof JSON.parse(fs.readFileSync(data.memoryPath, "utf8")).viewedAt, "string");
  assert.equal(fs.existsSync(data.completedPlanPath), false);
});

test("reasoning checkpoints inject only exact knowledge or Rabi context matches", (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const manager = new RabiContextManager();
  const irrelevant = manager.resolve({
    kind: "reasoning_pre_tool",
    source: "codex_hook",
    roleId: "YeYu",
    roleDir: data.roleDir,
    signalText: "npm test"
  });
  assert.equal(irrelevant.shouldInject, false);
  const matched = manager.resolve({
    kind: "reasoning_pre_tool",
    source: "codex_hook",
    roleId: "YeYu",
    roleDir: data.roleDir,
    signalText: "读取统一管理的资料"
  });
  assert.equal(matched.shouldInject, true);
  assert.equal(matched.reason, "knowledge_match");
  assert.equal(matched.policy.presentation, "recall_delta");
});

test("seen reasoning context does not refresh viewedAt again", (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const manager = new RabiContextManager();
  const first = manager.resolve({
    kind: "reasoning_pre_tool",
    source: "codex_hook",
    roleId: "YeYu",
    roleDir: data.roleDir,
    signalText: "统一管理"
  });
  const item = first.knowledge.requiredReadItems[0];
  assert.ok(item);
  const firstViewedAt = JSON.parse(fs.readFileSync(data.memoryPath, "utf8")).viewedAt;
  const second = manager.resolve({
    kind: "reasoning_post_tool",
    source: "codex_hook",
    roleId: "YeYu",
    roleDir: data.roleDir,
    signalText: "统一管理",
    seenContextKeys: [requiredReadContextKey(item)]
  });
  assert.equal(second.knowledge.requiredReadItems[0]?.id, "memory-hook");
  assert.equal(JSON.parse(fs.readFileSync(data.memoryPath, "utf8")).viewedAt, firstViewedAt);
});
