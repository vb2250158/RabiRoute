import { createHash } from "node:crypto";
import { normalizeAgentAdapters, type AgentAdapterType } from "../agentAdapters/types.js";
import { normalizeCodexHookSettings, resolvePrimaryAgentAdapter, type CodexHookSettings } from "../shared/gatewayConfigModel.js";
import type { CodexPlanAssistantSession } from "../shared/codexPlanAssistantSessions.js";
import {
  appendRolePanelTimelineMessage,
  readRolePanelTimeline,
  type RolePanelAttachment
} from "../rolePanelTimeline.js";
import type { PlanTaskCompletionDelivery } from "./codexHookContext.js";
import { resolvePlanSecretaryAssignment, type PlanSecretaryTarget } from "./planSecretaryAssignment.js";

export type PlanTaskCompletionRuntime = {
  definition: {
    id: string;
    agentRoleId?: string;
    agentAdapters?: AgentAdapterType[];
    primaryAgentAdapter?: AgentAdapterType;
    codexThreadId?: string;
    codexPlanAssistantEnabled?: boolean;
    codexPlanAssistantModel?: string;
    codexPlanAssistantSessions?: CodexPlanAssistantSession[];
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
  assignSecretary?: (runtime: TRuntime, delivery: PlanTaskCompletionDelivery) => PlanSecretaryTarget | undefined;
  sendToSecretary?: (
    runtime: TRuntime,
    target: PlanSecretaryTarget,
    delivery: PlanTaskCompletionDelivery,
    prompt: string
  ) => Promise<void>;
  publishEvent?: (eventType: string, data: Record<string, unknown>) => void;
};

function planTaskCompletionSourceLines(delivery: PlanTaskCompletionDelivery): string[] {
  const boundWorkspace = String(delivery.plan.taskBinding?.workspace || delivery.sourceCwd || "").trim();
  const sourceTitle = String(delivery.plan.taskBinding?.sessionTitle || delivery.sourceSessionId).trim();
  return [
    "[Agent 任务投递来源]",
    "来源 Agent：计划执行 Agent",
    `来源任务：${sourceTitle}`,
    `来源会话 ID：${delivery.sourceSessionId}`,
    delivery.sourceCwd ? `来源工作目录：${delivery.sourceCwd}` : "",
    "",
    "[投递内容]",
    "[计划会话任务完成提醒]",
    `计划：${delivery.plan.title}`,
    `计划 ID：${delivery.plan.id}`,
    `执行会话：${sourceTitle}`,
    `执行会话 ID：${delivery.sourceSessionId}`,
    `Turn ID：${delivery.sourceTurnId}`,
    delivery.sourceCwd ? `工作目录：${delivery.sourceCwd}` : "",
    "",
    "执行任务已完成本轮最终输出：",
    delivery.finalMessage,
    ""
  ];
}

export function planTaskCompletionAgentText(delivery: PlanTaskCompletionDelivery): string {
  const boundWorkspace = String(delivery.plan.taskBinding?.workspace || delivery.sourceCwd || "").trim();
  return [
    ...planTaskCompletionSourceLines(delivery),
    "结果已直达计划秘书。本轮完成以下事项：",
    "1. 读取计划、步骤、记忆和业务任务状态，消费本次结果；单轮结束不等于计划完成。",
    "2. 更新状态、nextAction、waitingFor、必要的 approvalRequest 和记忆。isBlocked 只由 Manager 派生。",
    `3. 计划仍可推进时，通过 POST /api/agent/threads 续投原业务任务 ${delivery.sourceSessionId}${boundWorkspace ? `（${boundWorkspace}）` : ""}；使用 sourceAgentType=plan_secretary、responsePolicy=required，并给出可验证的下一步。`,
    "4. 仅把决定、批准、授权、缺少输入或计划最终复核升级给主人格。",
    "5. taskBinding 只指向业务任务；秘书只维护控制面，不执行调查、代码、构建、发布或外部操作。",
    "6. PangHu 正式 Main 的 Editor 占用、导入、MCP 不可用或共享测试排队不构成全局等待；不得停止 Editor 或取消他人测试，原任务继续实现、静态资源/序列化合同、非 Unity runner、CLI 与收窄 SVN 工作，剩余运行交互转人工或后续验收。",
    "7. 检查可推进计划均有人管理，空闲业务任务已续投，运行中的任务未重复投递。"
  ].filter(Boolean).join("\n");
}

function planTaskCompletionPersonaFallbackText(delivery: PlanTaskCompletionDelivery): string {
  return [
    ...planTaskCompletionSourceLines(delivery),
    "当前 Route 没有启用并绑定可用的计划秘书，因此本次异常回退给主人格。",
    "主人格只需把这条结果交给一个计划秘书并等待阶段回执；不要自己展开全量计划读取、任务查重、计划/记忆写入或批量续投。"
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
    if (normalizeCodexHookSettings(runtime.definition.codexHooks).planTaskCompletionEnabled === false) {
      throw new Error(`Gateway ${runtime.definition.id} has disabled plan task completion notifications.`);
    }

    const eventKey = createHash("sha256")
      .update(`${delivery.roleId}\0${delivery.plan.id}\0${delivery.sourceSessionId}\0${delivery.sourceTurnId}`)
      .digest("hex")
      .slice(0, 24);
    const messageId = `plan-task-completed-${eventKey}`;
    const secretary = runtime.definition.codexPlanAssistantEnabled === true
      ? options.assignSecretary
        ? options.assignSecretary(runtime, delivery)
        : resolvePlanSecretaryAssignment(delivery.plan, runtime.definition.codexPlanAssistantSessions)?.target
      : undefined;
    if (secretary) {
      if (!options.sendToSecretary) throw new Error("Plan secretary completion delivery is configured without a secretary sender.");
      if (secretary.threadId === delivery.sourceSessionId) {
        throw new Error("Plan completion secretary target must differ from the completed task session to prevent a Stop-hook delivery loop.");
      }
      await options.sendToSecretary(runtime, secretary, delivery, planTaskCompletionAgentText(delivery));
      options.publishEvent?.("plan_task_completed", {
        roleId: delivery.roleId,
        planId: delivery.plan.id,
        sourceSessionId: delivery.sourceSessionId,
        sourceTurnId: delivery.sourceTurnId,
        gatewayId: runtime.definition.id,
        messageId,
        recipient: "secretary",
        secretaryThreadId: secretary.threadId
      });
      return;
    }

    const targetAdapters = normalizeAgentAdapters(runtime.definition.agentAdapters);
    const targetUsesCodex = resolvePrimaryAgentAdapter(
      targetAdapters,
      runtime.definition.primaryAgentAdapter
    ) === "codex";
    const targetSessionId = String(runtime.definition.codexThreadId || "").trim();
    if (targetUsesCodex && !targetSessionId) {
      throw new Error(`Gateway ${runtime.definition.id} has no bound Codex Desktop task.`);
    }
    if (targetSessionId && targetSessionId === delivery.sourceSessionId) {
      throw new Error("Plan completion reminder target must differ from the completed task session to prevent a Stop-hook delivery loop.");
    }

    const routeProfileId = runtime.definition.routeProfiles?.[0]?.id ?? runtime.definition.id;
    const text = planTaskCompletionPersonaFallbackText(delivery);
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
      messageId,
      recipient: "persona_fallback"
    });
  };
}
