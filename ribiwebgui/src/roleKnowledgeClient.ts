import type { RoleMemoryPayload, RolePlan, RolePlanFeedback } from "./types";
import type { PlanFeedbackAttachmentUpload } from "@shared/planFeedbackContract";
import { FALLBACK_PLAN_PRESENTATION_PALETTE, normalizePlanPresentationPalette } from "./planPresentationStyles";

export type RolePlanPageCounts = {
  total: number;
  current: number;
  plans: number;
  archived: number;
  blocked: number;
  qa: number;
  active: number;
};

export type RolePlanPage = {
  items: RolePlan[];
  total: number;
  nextCursor: string;
  counts: RolePlanPageCounts;
};

export const ROLE_PLAN_PAGE_SIZE = 8;
export const ROLE_PLAN_BACKGROUND_PAGE_SIZE = 32;

type RolePlanSummary = Pick<
  RolePlan,
  "id" | "title" | "status" | "priority" | "kind" | "project" | "createdAt" | "updatedAt" | "keywords" | "presentation"
> & {
  attachmentCount: number;
  stepCount: number;
};

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
    const fallbackViews: RolePlan["presentation"]["views"] = plan.status === "已归档"
      ? ["archived"]
      : plan.status === "进行中"
        ? ["current", "plans"]
        : ["plans"];
    return {
      ...plan,
      presentation: {
        ...plan.presentation,
        sortBucket: Number.isFinite(plan.presentation.sortBucket) ? plan.presentation.sortBucket : -1,
        views: Array.isArray(plan.presentation.views) && plan.presentation.views.length
          ? plan.presentation.views
          : fallbackViews,
        palette: normalizePlanPresentationPalette(plan.presentation.palette),
        approval: {
          ...plan.presentation.approval,
          state: plan.presentation.approval.state || (plan.presentation.approval.enabled ? "ready" : "none"),
          missing: Array.isArray(plan.presentation.approval.missing) ? plan.presentation.approval.missing : []
        }
      },
      approval: plan.approval || { count: 0 }
    };
  }
  const tone = plan.status === "进行中"
    ? "running"
    : plan.status === "暂停"
      ? "paused"
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
      sortBucket: -1,
      views: plan.status === "已归档" ? ["archived"] : plan.status === "进行中" ? ["current", "plans"] : ["plans"],
      palette: { ...FALLBACK_PLAN_PRESENTATION_PALETTE },
      approval: {
        state: "none",
        enabled: false,
        label: "无需审批",
        helper: "当前步骤没有声明人工审批门禁。",
        missing: []
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

export async function loadPlanFeedback(roleId: string, planId: string): Promise<RolePlan["approval"]> {
  const data = await managerData<RolePlan["approval"] & { records?: RolePlanFeedback[] }>(
    `/api/roles/${encodeURIComponent(roleId)}/plans/${encodeURIComponent(planId)}/feedback`
  );
  const records = Array.isArray(data.records) ? data.records : [];
  return {
    count: Number(data.count || records.length),
    latest: data.latest || records[0],
    records
  };
}

function summaryAsPlan(summary: RolePlanSummary): RolePlan {
  return withPresentation({
    ...summary,
    focus: "",
    attachments: [],
    steps: [],
    approval: { count: 0 }
  });
}

export async function loadRolePlanPage(
  roleId: string,
  cursor = "",
  limit = ROLE_PLAN_PAGE_SIZE
): Promise<RolePlanPage> {
  const params = new URLSearchParams({ limit: String(limit), detail: "summary" });
  if (cursor) params.set("cursor", cursor);
  const page = await managerData<Omit<RolePlanPage, "items"> & { items: RolePlanSummary[] }>(
    `/api/roles/${encodeURIComponent(roleId)}/plans?${params.toString()}`
  );
  return {
    ...page,
    items: page.items.map(summaryAsPlan)
  };
}

export async function loadRolePlan(roleId: string, planId: string): Promise<RolePlan> {
  return withPresentation(await managerData<RolePlan>(
    `/api/roles/${encodeURIComponent(roleId)}/plans/${encodeURIComponent(planId)}`
  ));
}

export async function loadRoleMemory(roleId: string): Promise<RoleMemoryPayload> {
  return managerData<RoleMemoryPayload>(`/api/roles/${encodeURIComponent(roleId)}/memory`);
}

export async function submitPlanFeedback(input: {
  roleId: string;
  planId: string;
  gatewayId: string;
  stepId?: string;
  feedbackId: string;
  text: string;
  attachments: PlanFeedbackAttachmentUpload[];
  planAttachmentIds: string[];
  source: "webgui" | "tray";
  kind: "guidance" | "approval_suggestion";
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
        attachments: input.attachments,
        planAttachmentIds: input.planAttachmentIds,
        source: input.source,
        kind: input.kind,
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
