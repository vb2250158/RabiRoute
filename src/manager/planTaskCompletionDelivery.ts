import { createHash } from "node:crypto";
import { normalizeAgentAdapters, type AgentAdapterType } from "../agentAdapters/types.js";
import { normalizeCodexHookSettings, type CodexHookSettings } from "../shared/gatewayConfigModel.js";
import {
  appendRolePanelTimelineMessage,
  readRolePanelTimeline,
  type RolePanelAttachment
} from "../rolePanelTimeline.js";
import type { PlanTaskCompletionDelivery } from "./codexHookContext.js";

export type PlanTaskCompletionRuntime = {
  definition: {
    id: string;
    agentRoleId?: string;
    agentAdapters?: AgentAdapterType[];
    codexThreadId?: string;
    codexHooks?: CodexHookSettings;
    routeProfiles?: Array<{ id: string }>;
  };
};

export type PlanTaskCompletionDeliveryOptions<TRuntime extends PlanTaskCompletionRuntime> = {
  getRuntime: (gatewayId: string) => TRuntime | undefined;
  listRuntimes: () => TRuntime[];
  roleIdForDefinition: (definition: TRuntime["definition"]) => string;
  triggerRolePanelMessage: (
    runtime: TRuntime,
    messageId: string,
    text: string,
    attachments: RolePanelAttachment[]
  ) => Promise<void>;
  publishEvent?: (eventType: string, data: Record<string, unknown>) => void;
};

export function planTaskCompletionAgentText(delivery: PlanTaskCompletionDelivery): string {
  return [
    "[计划会话任务完成提醒]",
    `计划：${delivery.plan.title}`,
    `计划 ID：${delivery.plan.id}`,
    `执行会话：${delivery.plan.taskBinding?.sessionTitle || delivery.sourceSessionId}`,
    `执行会话 ID：${delivery.sourceSessionId}`,
    `Turn ID：${delivery.sourceTurnId}`,
    delivery.sourceCwd ? `工作目录：${delivery.sourceCwd}` : "",
    "",
    "执行任务已完成本轮最终输出：",
    delivery.finalMessage,
    "",
    "请读取该计划和绑定任务的真实状态，消费本次阶段结果；按一计划一会话规则更新计划、记忆并决定继续、阻塞确认或收口。不要仅因收到本提醒就把计划标为完成。"
  ].filter(Boolean).join("\n");
}

export function createPlanTaskCompletionDelivery<TRuntime extends PlanTaskCompletionRuntime>(
  options: PlanTaskCompletionDeliveryOptions<TRuntime>
): (delivery: PlanTaskCompletionDelivery) => Promise<void> {
  function runtimeForRoleDelivery(roleId: string, gatewayId: string): TRuntime {
    if (gatewayId) {
      const runtime = options.getRuntime(gatewayId);
      if (!runtime) throw new Error(`Gateway not found: ${gatewayId}`);
      if (options.roleIdForDefinition(runtime.definition) !== roleId) {
        throw new Error(`Gateway ${gatewayId} is not bound to role ${roleId}.`);
      }
      return runtime;
    }
    const matches = options.listRuntimes()
      .filter((runtime) => options.roleIdForDefinition(runtime.definition) === roleId);
    if (matches.length === 0) throw new Error(`No gateway is bound to role ${roleId}.`);
    if (matches.length > 1) throw new Error(`Multiple gateways are bound to role ${roleId}; gatewayId is required.`);
    return matches[0];
  }

  return async (delivery: PlanTaskCompletionDelivery): Promise<void> => {
    const runtime = runtimeForRoleDelivery(delivery.roleId, String(delivery.gatewayId || "").trim());
    const targetUsesCodex = normalizeAgentAdapters(runtime.definition.agentAdapters).includes("codex");
    if (normalizeCodexHookSettings(runtime.definition.codexHooks).planTaskCompletionEnabled === false) {
      throw new Error(`Gateway ${runtime.definition.id} has disabled plan task completion notifications.`);
    }
    const targetSessionId = String(runtime.definition.codexThreadId || "").trim();
    if (targetUsesCodex && !targetSessionId) {
      throw new Error(`Gateway ${runtime.definition.id} has no bound Codex Desktop task.`);
    }
    if (targetSessionId && targetSessionId === delivery.sourceSessionId) {
      throw new Error("Plan completion reminder target must differ from the completed task session to prevent a Stop-hook delivery loop.");
    }

    const eventKey = createHash("sha256")
      .update(`${delivery.roleId}\0${delivery.plan.id}\0${delivery.sourceSessionId}\0${delivery.sourceTurnId}`)
      .digest("hex")
      .slice(0, 24);
    const messageId = `plan-task-completed-${eventKey}`;
    const routeProfileId = runtime.definition.routeProfiles?.[0]?.id ?? runtime.definition.id;
    const text = planTaskCompletionAgentText(delivery);
    const exists = readRolePanelTimeline(delivery.roleDir, 5000).some((message) => message.id === messageId);
    if (!exists) {
      appendRolePanelTimelineMessage(delivery.roleDir, {
        id: messageId,
        time: Math.floor(Date.now() / 1000),
        roleId: delivery.roleId,
        gatewayId: runtime.definition.id,
        routeProfileId,
        direction: "user",
        sender: "Rabi 计划 Hook",
        text,
        attachments: [],
        status: "sent",
        replyContext: {
          runtimeRouteId: runtime.definition.id,
          gatewayId: runtime.definition.id,
          routeProfileId,
          routeKind: "role_panel_message",
          targetType: "plan_task_completion",
          adapterType: "rolePanel",
          messageId,
          roleId: delivery.roleId,
          planId: delivery.plan.id,
          sourceSessionId: delivery.sourceSessionId,
          sourceTurnId: delivery.sourceTurnId
        }
      });
    }
    await options.triggerRolePanelMessage(runtime, messageId, text, []);
    options.publishEvent?.("plan_task_completed", {
      roleId: delivery.roleId,
      planId: delivery.plan.id,
      sourceSessionId: delivery.sourceSessionId,
      sourceTurnId: delivery.sourceTurnId,
      gatewayId: runtime.definition.id,
      messageId
    });
  };
}
