import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendRolePanelTimelineMessageIfAbsent, readRolePanelTimeline } from "../rolePanelTimeline.js";
import type { GatewayDefinition } from "../shared/gatewayConfigModel.js";
import type { GatewayRuntime } from "./runtimeRegistry.js";
import { deliverRolePanelMessage, RolePanelDeliveryError } from "./rolePanelDelivery.js";

function runtime(): GatewayRuntime {
  const definition: GatewayDefinition = {
    id: "builder-main",
    name: "Builder Route",
    enabled: true,
    gatewayPort: 9000,
    agentRoleId: "Builder",
    agentAdapters: ["codex"]
  };
  return {
    definition,
    process: null,
    needsRestart: false,
    startedAt: null,
    stoppedAt: null,
    lastExit: null,
    readiness: "stopped",
    endpoints: [],
    lastError: null,
    log: []
  };
}

test("role-panel delivery records sent only after the handler accepts it", async (t) => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-role-panel-delivery-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  const result = await deliverRolePanelMessage({
    runtime: runtime(),
    roleId: "Builder",
    sender: "拉比",
    text: "请检查构建。",
    attachments: [],
    messageIdPrefix: "persona-message",
    replyContext: { crossPersona: true },
    deliver: async () => {
      assert.equal(readRolePanelTimeline(roleDir).length, 0);
    },
    appendTimeline: async (_roleId, message) => appendRolePanelTimelineMessageIfAbsent(roleDir, message)
  });
  assert.equal(result.status, "delivered");
  assert.equal(readRolePanelTimeline(roleDir)[0].status, "sent");
});

test("role-panel delivery records failed and never leaves a false sent row", async (t) => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-role-panel-delivery-failed-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  await assert.rejects(() => deliverRolePanelMessage({
    runtime: runtime(),
    roleId: "Builder",
    sender: "本地用户",
    text: "失败路径",
    attachments: [],
    messageIdPrefix: "role-panel-user",
    deliver: async () => {
      assert.equal(readRolePanelTimeline(roleDir).length, 0);
      throw new Error("Desktop owner unavailable");
    },
    appendTimeline: async (_roleId, message) => appendRolePanelTimelineMessageIfAbsent(roleDir, message)
  }), (error: unknown) => error instanceof RolePanelDeliveryError && error.statusCode === 502);
  const timeline = readRolePanelTimeline(roleDir);
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].status, "failed");
});
