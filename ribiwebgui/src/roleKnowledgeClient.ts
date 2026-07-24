import type { RoleMemoryPayload, RolePlan, RolePlanFeedback } from "./types";

type ManagerEnvelope<T> = {
  code: number;
  message?: string;
  data?: T;
};

async function managerData<T>(path: string): Promise<T> {
  const response = await fetch(path);
  const body = await response.json().catch(() => ({})) as ManagerEnvelope<T>;
  if (!response.ok || body.code !== 0 || body.data == null) {
    throw new Error(body.message || `Manager request failed (HTTP ${response.status}).`);
  }
  return body.data;
}

function withPresentation(plan: RolePlan): RolePlan {
  if (plan.presentation?.status && plan.presentation?.tone && plan.presentation.approval) {
    return { ...plan, approval: plan.approval || { count: 0 } };
  }
  const tone = plan.status === "进行中"
    ? "running"
    : plan.status === "未开始"
      ? "pending"
      : plan.status === "已完成"
        ? "done"
        : plan.status === "已归档"
          ? "archived"
          : "unknown";
  return {
    ...plan,
    presentation: {
      status: plan.status,
      tone,
      approval: {
        enabled: false,
        label: "审批建议",
        helper: "意见会由 Rabi Manager 记录并交给 Agent；提交本身不会直接推进计划。"
      }
    },
    approval: plan.approval || { count: 0 }
  };
}

export async function loadRoleKnowledge(roleId: string): Promise<{ plans: RolePlan[]; memory: RoleMemoryPayload }> {
  const encodedRoleId = encodeURIComponent(roleId);
  const [plans, memory] = await Promise.all([
    managerData<RolePlan[]>(`/api/roles/${encodedRoleId}/plans`),
    managerData<RoleMemoryPayload>(`/api/roles/${encodedRoleId}/memory`)
  ]);
  return { plans: plans.map(withPresentation), memory };
}

export async function submitPlanFeedback(input: {
  roleId: string;
  planId: string;
  gatewayId: string;
  stepId?: string;
  feedbackId: string;
  text: string;
  source: "webgui" | "tray";
}): Promise<RolePlanFeedback> {
  const response = await fetch(
    `/api/roles/${encodeURIComponent(input.roleId)}/plans/${encodeURIComponent(input.planId)}/feedback`,
    {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        feedbackId: input.feedbackId,
        gatewayId: input.gatewayId,
        stepId: input.stepId,
        text: input.text,
        source: input.source,
        kind: "approval_suggestion",
        author: "user",
        notifyAgent: true
      })
    }
  );
  const body = await response.json().catch(() => ({})) as ManagerEnvelope<RolePlanFeedback>;
  if (!response.ok || body.code !== 0 || !body.data) {
    throw new Error(body.message || `Manager request failed (HTTP ${response.status}).`);
  }
  return body.data;
}
