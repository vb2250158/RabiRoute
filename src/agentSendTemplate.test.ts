import assert from "node:assert/strict";
import test from "node:test";
import { agentSendRequestTemplateForSource } from "./agentSendTemplate.js";

test("Agent send template identifies the Codex primary persona sender type", () => {
  const request = agentSendRequestTemplateForSource({
    routeId: "route-main",
    targetType: "group",
    groupId: "group-1"
  });
  const sender = request?.sender as { agentType?: unknown } | undefined;
  assert.match(String(sender?.agentType || ""), /primary_persona/);
  assert.match(String(sender?.agentType || ""), /仅在开启 Codex 主人格发送限制时/);
});
