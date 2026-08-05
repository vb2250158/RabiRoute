import assert from "node:assert/strict";
import test from "node:test";
import { buildRoleKnowledgeContextView, planMemoryApiHint } from "./roleKnowledgeContext.js";

test("AgentPacket plan hints explain shared guidance and approval feedback workflows", () => {
  const hints = planMemoryApiHint("Rabi Test").join("\n");

  assert.match(hints, /\/api\/roles\/Rabi%20Test\/plans\/\{planId\}\/feedback/);
  assert.match(hints, /source=qq/);
  assert.match(hints, /kind=guidance/);
  assert.match(hints, /guidance_response/);
  assert.match(hints, /kind=approval_response/);
  assert.match(hints, /调整未开始步骤/);
  assert.match(hints, /不直接推进步骤/);
  assert.match(hints, /另行 PATCH/);
  assert.match(hints, /approvalRequest/);
  assert.match(hints, /files\/commands\/changes/);
  assert.match(hints, /完整命令/);
  assert.match(hints, /isBlocked 是兼容投影，不要手写/);
  assert.match(hints, /approver/);
  assert.match(hints, /recommendation/);
  assert.match(hints, /sourceMessageId/);
  assert.match(hints, /信息不完整时计划保持进行中并禁止正式审批/);
  assert.match(hints, /status=暂停/);
  assert.match(hints, /currentStepId/);
  assert.match(hints, /计划 POST\/PATCH 的 attachments/);
  assert.match(hints, /name\/mimeType\/contentBase64/);
  assert.match(hints, /GET \/api\/personas\?addressable=true/);
  assert.match(hints, /sourceRouteId/);
  assert.match(hints, /sourceCapability/);
  assert.match(hints, /deliveryId/);
  assert.match(hints, /personaMessageMaxHops/);
});

test("focused AgentPacket hints keep plan attachment discovery available", () => {
  const view = buildRoleKnowledgeContextView("Rabi Test", {
    contextInjection: { mode: "focused" },
    requiredReadItems: [],
    matchedSkills: [],
    activePlans: [],
    activeSkills: [],
    recentMemories: [],
    matchedItems: []
  } as unknown as Parameters<typeof buildRoleKnowledgeContextView>[1]);
  const hints = view.apiHintLines.join("\n");

    assert.match(hints, /待审批计划/);
    assert.match(hints, /计划 attachments/);
    assert.match(hints, /图片、视频预览/);
    assert.match(hints, /POST \/api\/personas\/\{personaId\}\/messages/);
  });
