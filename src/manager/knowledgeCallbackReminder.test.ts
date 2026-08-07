import assert from "node:assert/strict";
import test from "node:test";
import { buildKnowledgeCallbackReminderPrompt } from "./controlPlaneRoutes.js";
import type { KnowledgeRecallMatch, MessageProcessingRequirement } from "../messageProcessing/board.js";

test("one-hour reminder names every missing plan or memory and the callback API", () => {
  const requirement: MessageProcessingRequirement = {
    id: "requirement-1",
    dedupeKey: "message-group:requirement-1",
    kind: "message_reply",
    replyPolicy: "agent_decides",
    status: "processing",
    source: {
      routeId: "demo-main",
      roleId: "DemoPersona",
      endpoint: "napcat",
      conversationKey: "group:example-group",
      sender: "示例成员",
      routeKinds: ["group_message"],
      messageIds: ["123", "124"],
      summary: "活动日历领取没有反应"
    },
    createdAt: "2026-08-05T06:00:00.000Z",
    updatedAt: "2026-08-05T06:00:00.000Z",
    dueAt: "2026-08-05T06:30:00.000Z"
  };
  const pending: KnowledgeRecallMatch[] = [
    { id: "plan-calendar", title: "活动日历", type: "plan", endpoint: "/api/roles/X/plans/plan-calendar", score: 25, revisionAt: "2026-08-05T05:00:00.000Z" },
    { id: "memory-calendar", title: "活动日历历史", type: "recent_memory", endpoint: "/api/roles/X/memory/recent/memory-calendar", score: 20, revisionAt: "2026-08-05T04:00:00.000Z" }
  ];
  const prompt = buildKnowledgeCallbackReminderPrompt(requirement, pending, 8790);
  assert.match(prompt, /投递消息后一小时/);
  assert.match(prompt, /plan-calendar/);
  assert.match(prompt, /memory-calendar/);
  assert.match(prompt, /result=unchanged/);
  assert.match(prompt, /requirements\/requirement-1\/knowledge-callback/);
  assert.match(prompt, /原消息 ID：123, 124/);
});
