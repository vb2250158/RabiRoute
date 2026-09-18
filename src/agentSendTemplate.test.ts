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

test("NapCat send template steers the Agent toward image-with-caption by default", () => {
  const request = agentSendRequestTemplateForSource({
    routeId: "route-main",
    targetType: "group",
    groupId: "group-1",
    instanceId: "napcat-1"
  });
  const payload = request?.payload as Record<string, unknown> | undefined;
  // The template must not hand the Agent a ready-made text-only payload.
  assert.match(String(payload?.type || ""), /image/);
  assert.match(String(payload?.type || ""), /text/);
  // A pasteable image path placeholder is required for the Agent to reach for image sends.
  assert.match(String(payload?.path || ""), /allowedFileRoots|output|图片路径/);
  assert.match(String(payload?.text || ""), /图片来源/);
});

test("non-NapCat channels get no image path placeholder", () => {
  const speech = agentSendRequestTemplateForSource({
    routeId: "route-main",
    targetType: "voice_transcript",
    adapterType: "speech",
    sessionId: "speech-1"
  });
  const payload = speech?.payload as Record<string, unknown> | undefined;
  assert.equal(payload?.path, undefined);
  assert.match(String(payload?.type || ""), /image/);
  assert.match(String(payload?.type || ""), /text/);
});
