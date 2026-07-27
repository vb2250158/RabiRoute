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
  const boundWorkspace = String(delivery.plan.taskBinding?.workspace || delivery.sourceCwd || "").trim();
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
    "这不是只需确认收到的通知。主人格必须在同一轮完成以下闭环：",
    "1. GET 读取该计划、当前步骤、记忆和绑定任务的真实状态，消费阶段结果；不要仅因本轮结束就把整个计划标为完成。",
    "2. PATCH 更新计划步骤、状态、nextAction、waitingFor、阻塞事实和记忆；等待负责人或审批时，先执行已授权的询问、追问或补证据动作，不得越过审批门禁。",
    `3. 若计划仍未终态、未暂停且没有真实阻塞，立即 POST /api/agent/threads，action=send，精确续投 plan.taskBinding.sessionId=${delivery.sourceSessionId}${boundWorkspace ? `、workspace=${boundWorkspace}` : ""} 对应的原协助任务；续投正文必须给出一个可验证的下一步。不得仅按槽位名称猜任务，也不得留到下一次 heartbeat。`,
    "4. 若计划已完成或暂停，PATCH taskBinding=null 释放协助槽；随后枚举其他未终态计划，把空闲槽立即绑定并投递给下一条可推进计划。缩容或释放绑定不删除 Desktop 任务。",
    "5. 检查全部协助槽和全部未终态计划；存在多个可独立推进的计划时并行占满可用槽位。本轮结束前必须满足：可推进但空闲的计划数 = 0。active/in-progress 任务不要重复投递。",
    "协助任务可以创建临时子 Agent 加快边界清楚的并行工作，但长期 owner 仍是协助任务；必须由它汇总结果、更新计划并回传主人格。"
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
