import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAgentPacket } from "./agentPacket.js";
import { resolvePipeline } from "../pipelines.js";
import type { RouteDecision } from "./routeDecision.js";
import type { NotificationRule } from "../config.js";

test("ordinary and companion delivery carry the current event once and query detail on demand", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brief-packet-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  process.env.GATEWAY_MANAGER_URL ||= "http://127.0.0.1:8790";
  const rule: NotificationRule = { id: "brief", name: "brief", enabled: true, routeKinds: ["role_panel_message"],
    template: "[RabiRoute 数据解构]\n[消息]\n{message}\n[行动]\n不得查询计划" };
  const decision: RouteDecision = { routeKind: "role_panel_message", record: { time: Date.now(), messageId: "one", roleId: "Example",
    adapterType: "rolePanel", rawMessage: "游戏在前台", replyContext: { companion: { reviewId: "review" } } },
    route: { id: "brief", name: "brief", enabled: true, agentRoleId: "Example", agentRoleFile: "persona.md", rolesDir: root,
      dataDir: root, recentMessageLimit: 12, resolvedPipeline: resolvePipeline("agent"), routeVariables: {}, notificationRules: [rule] },
    routeVariables: {}, extraValues: {}, matchedRules: [rule], routeText: "游戏在前台" };
  const packet = buildAgentPacket(decision, rule, { roleId: "Example", roleDir: root, rolePath: path.join(root, "persona.md"), dataDir: root });
  assert.equal(packet.message.split("游戏在前台").length - 1, 1);
  assert.match(packet.message, /桌宠陪伴观察/);
  assert.doesNotMatch(packet.message, /不得|禁止|情景记录|最近消息|记忆与计划|处理前上下文确认|\[日志\]|回传参数|用户模板补充/);
  assert.ok(packet.message.length < 650);
  assert.equal(packet.templateValues.recentMessageLimit, 0);
  if ("replyContext" in decision.record) decision.record.replyContext = {};
  assert.match(buildAgentPacket(decision, rule, { roleId: "Example", roleDir: root, rolePath: "", dataDir: root }).message, /GET \/api\/agent\/help/);
});
