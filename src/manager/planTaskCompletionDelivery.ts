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
    "这不是只需确认收到的通知。主人格必须在同一轮先把闭环交给计划管理秘书，不得自己展开长时间计划处理：",
    "1. 立即向负责该计划分片的秘书投递本业务结果；主人格不亲自做全量计划读取、任务查重、绑定迁移、问题账本/记忆写入或批量续投。",
    "2. 由秘书 GET 读取该计划、当前步骤、记忆和绑定任务的真实状态并消费阶段结果；不要仅因本轮结束就把整个计划标为完成。",
    "3. 由秘书 PATCH 更新计划步骤、状态、nextAction、waitingFor、必要的 approvalRequest 和记忆；只有完整、可提交且 responseStatus=pending 的审批合同会由 Manager 自动派生阻塞，isBlocked 不得手写。其它困难继续询问、重试、改道、拆分或补证据。",
    `4. 这是计划的独立业务任务完成提醒。若计划仍未终态、未暂停且没有真实阻塞，由秘书 POST /api/agent/threads，action=send，精确续投 plan.taskBinding.sessionId=${delivery.sourceSessionId}${boundWorkspace ? `、workspace=${boundWorkspace}` : ""} 对应的原业务任务；续投正文必须给出一个可验证的下一步。`,
    "5. 不得把任何“协助处理计划”秘书会话写入 taskBinding，也不得因秘书轮转或计划暂停清空业务 taskBinding。只有业务任务确实失效并完成受控迁移时才改绑；计划完成后可保留绑定作为历史证据。",
    "6. 由秘书检查全部计划管理秘书、全部未终态计划和对应业务任务；秘书负责计划/记忆更新、任务查重、结果消费和续投，禁止亲自执行调查、代码/Prefab/配置、Unity/SVN/构建/发布或外部系统操作。",
    "7. 存在多个可独立推进的计划时并行使用秘书槽管理不同分片，并让所有可推进的业务任务运行。本轮结束前必须满足：可推进但无人管理的计划数 = 0，且可推进但空闲的业务任务数 = 0。active/in-progress 业务任务不要重复投递。",
    "秘书可以创建临时子 Agent 加快计划盘点、任务查重、状态核对和结果摘要；秘书及其子 Agent 都不是业务 owner，业务执行仍由 plan.taskBinding 指向的独立任务负责。"
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
