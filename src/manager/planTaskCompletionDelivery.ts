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
    "这条结果已经直接投递给负责该计划的秘书，不需要主人格先转发。秘书必须在同一轮完成控制面闭环：",
    "1. GET 读取该计划、当前步骤、记忆和绑定任务的真实状态并消费阶段结果；不要仅因本轮结束就把整个计划标为完成。",
    "2. PATCH 更新计划步骤、状态、nextAction、waitingFor、必要的 approvalRequest 和记忆；只有完整、可提交且 responseStatus=pending 的审批合同会由 Manager 自动派生阻塞，isBlocked 不得手写。其它困难继续询问、重试、改道、拆分或补证据。",
    `3. 若计划仍未终态、未暂停且没有真实阻塞，通过 POST /api/agent/threads，action=send，精确续投 plan.taskBinding.sessionId=${delivery.sourceSessionId}${boundWorkspace ? `、workspace=${boundWorkspace}` : ""} 对应的原业务任务；填写当前秘书自己的 sourceThreadId、sourceAgentType=plan_secretary、responsePolicy=required 和 responseInstruction=完成下一步后返回结果与后续动作，续投正文必须给出一个可验证的下一步。`,
    "4. 普通进展、状态变化、等待条件和可继续执行的下一步由秘书直接处理，不要转给主人格。只有确实需要用户或主人格做决定、批准、授权、补充输入，或者计划已经完整收尾并需要最终复核/对外说明时，才通过 Manager 线程桥升级给主人格。",
    "5. 不得把任何“协助处理计划”秘书会话写入 taskBinding，也不得因秘书轮转或计划暂停清空业务 taskBinding。只有业务任务确实失效并完成受控迁移时才改绑；计划完成后可保留绑定作为历史证据。",
    "6. 秘书负责计划/记忆更新、任务查重、结果消费和续投，禁止亲自执行调查、代码/Prefab/配置、Unity/SVN/构建/发布或外部系统操作。",
    "7. 本轮结束前检查是否还有可推进但无人管理的计划，以及可推进但空闲的业务任务；active/in-progress 业务任务不要重复投递。",
    "秘书可以创建临时子 Agent 加快计划盘点、任务查重、状态核对和结果摘要；秘书及其子 Agent 都不是业务 owner，业务执行仍由 plan.taskBinding 指向的独立任务负责。"
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
