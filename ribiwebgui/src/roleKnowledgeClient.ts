import type { RoleMemory, RoleMemoryPayload, RolePlan, RolePlanFeedback, RolePlanHistoryRecord } from "./types";
import type { PlanFeedbackAttachmentUpload } from "@shared/planFeedbackContract";
import { FALLBACK_PLAN_PRESENTATION_PALETTE, normalizePlanPresentationPalette } from "./planPresentationStyles";
import { knowledgeItemMatchesQuery } from "./knowledgeSearch";

export type RolePlanPageCounts = {
  total: number;
  current: number;
  plans: number;
  archived: number;
  blocked: number;
  qa: number;
  active: number;
  stages: {
    executing: number;
    qa: number;
    waitingPackage: number;
    approval: number;
    manualVerification: number;
    paused: number;
    completed: number;
    archived: number;
  };
};

export type RolePlanPage = {
  items: RolePlan[];
  total: number;
  nextCursor: string;
  counts: RolePlanPageCounts;
  facets: {
    statuses: Array<{
      status: string;
      count: number;
      palette: RolePlan["presentation"]["palette"];
    }>;
    tags: Array<{
      tag: string;
      count: number;
    }>;
  };
};

export type RolePlanPageWithPriorityDetails = RolePlanPage & {
  detailPlanIds: string[];
};

export type PlanAgentRole = "task" | "secretary";
export type PlanAgentWorkStatus = "working" | "idle" | "unknown";
export type PlanAgentSessionStatus =
  | "active"
  | "idle"
  | "not_loaded"
  | "unavailable"
  | "archived"
  | "missing"
  | "workspace_mismatch"
  | "unbound"
  | "unknown";

export type PlanAgentBindingStatus = {
  role: PlanAgentRole;
  configured: boolean;
  agentType: "codex" | "dsh";
  threadId: string;
  threadTitle: string;
  workspace: string;
  working: boolean;
  agentStatus: PlanAgentWorkStatus;
  sessionStatus: PlanAgentSessionStatus;
  canOpen: boolean;
  checkedAt: string;
  message?: string;
};

export type PlanAgentStatus = {
  planId: string;
  checkedAt: string;
  taskAgent: PlanAgentBindingStatus;
  secretaryAgent?: PlanAgentBindingStatus;
};

export type PlanAgentStatusBatch = {
  items: PlanAgentStatus[];
  missingPlanIds: string[];
  failedPlanIds: string[];
};

export type RoleMemoryPageCounts = {
  recent: number;
  consolidated: number;
  archived: number;
  consolidationRuns: number;
};

export type RoleKnowledgeFileCounts = {
  activePlans: number;
  archivedPlans: number;
  recentMemory: number;
  consolidatedMemory: number;
  consolidationRuns: number;
};

export type RoleMemoryKind = "recent" | "consolidated" | "archived";

export type RoleMemoryPage = {
  items: RoleMemory[];
  total: number;
  nextCursor: string;
  counts: RoleMemoryPageCounts;
};

export const ROLE_PLAN_PAGE_SIZE = 8;
export const ROLE_PLAN_BACKGROUND_PAGE_SIZE = 250;
export const ROLE_MEMORY_BACKGROUND_PAGE_SIZE = 100;

export type RolePlanPageFilter = {
  view?: "current" | "plans" | "archived";
  query?: string;
  sort?: "status" | "updated" | "importance" | "urgency";
  statuses?: string[];
  tags?: string[];
  includeFacets?: boolean;
};

type RolePlanSummary = Pick<
  RolePlan,
  "id" | "title" | "status" | "importance" | "urgency" | "priority" | "kind" | "project" | "secretaryBinding" | "taskBinding" | "createdAt" | "updatedAt" | "keywords" | "presentation"
> & {
  attachmentCount: number;
  stepCount: number;
};

type ManagerEnvelope<T> = {
  code: number;
  message?: string;
  data?: T;
};

async function managerData<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = await response.json().catch(() => ({})) as ManagerEnvelope<T>;
  if (!response.ok || body.code !== 0 || body.data == null) {
    throw new Error(body.message || `Manager request failed (HTTP ${response.status}).`);
  }
  return body.data;
}

export function normalizeRolePlanFromManager(plan: RolePlan): RolePlan {
  if (plan.presentation?.status && plan.presentation?.tone && plan.presentation.approval) {
    return {
      ...plan,
      presentation: {
        ...plan.presentation,
        statusLevel: Number.isFinite(plan.presentation.statusLevel)
          ? plan.presentation.statusLevel
          : plan.presentation.sortBucket,
        sortBucket: Number.isFinite(plan.presentation.sortBucket) ? plan.presentation.sortBucket : -1,
        views: Array.isArray(plan.presentation.views) ? plan.presentation.views : [],
        palette: normalizePlanPresentationPalette(plan.presentation.palette),
        importance: plan.presentation.importance ? {
          ...plan.presentation.importance,
          palette: normalizePlanPresentationPalette(plan.presentation.importance.palette)
        } : undefined,
        urgency: plan.presentation.urgency ? {
          ...plan.presentation.urgency,
          palette: normalizePlanPresentationPalette(plan.presentation.urgency.palette)
        } : undefined,
        approval: {
          ...plan.presentation.approval,
          state: plan.presentation.approval.state || (plan.presentation.approval.enabled ? "ready" : "none"),
          missing: Array.isArray(plan.presentation.approval.missing) ? plan.presentation.approval.missing : []
        }
      },
      approval: plan.approval || { count: 0 }
    };
  }
  return {
    ...plan,
    presentation: {
      status: "状态未知",
      tone: "unknown",
      sortBucket: -1,
      views: [],
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
  return { plans: plans.map(normalizeRolePlanFromManager), memory };
}

export async function loadRoleKnowledgeFileCounts(roleId: string): Promise<RoleKnowledgeFileCounts> {
  return managerData<RoleKnowledgeFileCounts>(`/api/roles/${encodeURIComponent(roleId)}/counts`);
}

export async function loadPendingMemoryConsolidationRunCount(roleId: string): Promise<number> {
  const runs = await managerData<Array<{ status?: string }>>(
    `/api/roles/${encodeURIComponent(roleId)}/memory/consolidation-runs`
  );
  return runs.filter((run) => run?.status === "requested").length;
}

export async function loadPlanHistory(roleId: string, planId: string): Promise<RolePlanHistoryRecord[]> {
  const data = await managerData<{ records?: RolePlanHistoryRecord[] }>(
    `/api/roles/${encodeURIComponent(roleId)}/plans/${encodeURIComponent(planId)}/history`
  );
  return Array.isArray(data.records) ? data.records : [];
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
  return normalizeRolePlanFromManager({
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
  limit = ROLE_PLAN_PAGE_SIZE,
  filter: RolePlanPageFilter = {}
): Promise<RolePlanPage> {
  const params = new URLSearchParams({ limit: String(limit), detail: "summary" });
  if (cursor) params.set("cursor", cursor);
  if (filter.view) params.set("view", filter.view);
  if (filter.query?.trim()) params.set("query", filter.query.trim());
  if (filter.sort && filter.sort !== "status") params.set("sort", filter.sort);
  for (const status of filter.statuses || []) params.append("status", status);
  for (const tag of filter.tags || []) params.append("tag", tag);
  if (filter.includeFacets === false) params.set("facets", "0");
  const page = await managerData<Omit<RolePlanPage, "items"> & { items: RolePlanSummary[] }>(
    `/api/roles/${encodeURIComponent(roleId)}/plans?${params.toString()}`
  );
  return {
    ...page,
    items: page.items.map(summaryAsPlan)
  };
}

export async function loadRolePlan(roleId: string, planId: string): Promise<RolePlan> {
  return normalizeRolePlanFromManager(await managerData<RolePlan>(
    `/api/roles/${encodeURIComponent(roleId)}/plans/${encodeURIComponent(planId)}`
  ));
}

const PLAN_AGENT_STATUS_CHUNK_SIZE = 40;

function planAgentStatusChunks(planIds: string[]): string[][] {
  const unique = [...new Set(planIds.map((planId) => planId.trim()).filter(Boolean))];
  const chunks: string[][] = [];
  for (let index = 0; index < unique.length; index += PLAN_AGENT_STATUS_CHUNK_SIZE) {
    chunks.push(unique.slice(index, index + PLAN_AGENT_STATUS_CHUNK_SIZE));
  }
  return chunks;
}

export async function loadPlanAgentStatuses(
  roleId: string,
  planIds: string[],
  timeoutMs = 3_000
): Promise<PlanAgentStatusBatch> {
  const chunks = planAgentStatusChunks(planIds);
  if (!chunks.length) return { items: [], missingPlanIds: [], failedPlanIds: [] };
  const results = await Promise.allSettled(chunks.map(async (chunk) => {
    const params = new URLSearchParams();
    for (const planId of chunk) params.append("planId", planId);
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    try {
      const data = await managerData<{ items: PlanAgentStatus[]; missingPlanIds?: string[] }>(
        `/api/roles/${encodeURIComponent(roleId)}/plan-agents/status?${params.toString()}`,
        { signal: controller.signal }
      );
      return {
        planIds: chunk,
        items: Array.isArray(data.items) ? data.items : [],
        missingPlanIds: Array.isArray(data.missingPlanIds) ? data.missingPlanIds : []
      };
    } finally {
      globalThis.clearTimeout(timer);
    }
  }));
  const items: PlanAgentStatus[] = [];
  const missingPlanIds: string[] = [];
  const failedPlanIds: string[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      items.push(...result.value.items);
      missingPlanIds.push(...result.value.missingPlanIds);
    } else {
      const index = results.indexOf(result);
      failedPlanIds.push(...(chunks[index] || []));
    }
  }
  return {
    items,
    missingPlanIds: [...new Set(missingPlanIds)],
    failedPlanIds: [...new Set(failedPlanIds)]
  };
}

export async function openPlanAgentTask(
  roleId: string,
  planId: string,
  role: PlanAgentRole
): Promise<{ opened: true; agentType: "codex" | "dsh"; threadId: string; threadTitle: string; workspace: string }> {
  return managerData(
    `/api/roles/${encodeURIComponent(roleId)}/plan-agents/${encodeURIComponent(planId)}/open`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role })
    }
  );
}

export async function loadRolePlanPageWithPriorityDetails(
  roleId: string,
  cursor = "",
  limit = ROLE_PLAN_PAGE_SIZE,
  filter: RolePlanPageFilter = {},
  priorityDetailCount = 2
): Promise<RolePlanPageWithPriorityDetails> {
  const page = await loadRolePlanPage(roleId, cursor, limit, filter);
  const priorityItems = page.items.slice(0, Math.max(0, Math.floor(priorityDetailCount)));
  const detailResults = await Promise.allSettled(
    priorityItems.map((item) => loadRolePlan(roleId, item.id))
  );
  const details = new Map<string, RolePlan>();
  for (const result of detailResults) {
    if (result.status === "fulfilled") details.set(result.value.id, result.value);
  }
  return {
    ...page,
    items: page.items.map((item) => details.get(item.id) || item),
    detailPlanIds: priorityItems.map((item) => item.id).filter((id) => details.has(id))
  };
}

export async function loadRoleMemory(roleId: string): Promise<RoleMemoryPayload> {
  return managerData<RoleMemoryPayload>(`/api/roles/${encodeURIComponent(roleId)}/memory`);
}

export async function loadRoleMemoryCounts(roleId: string): Promise<RoleMemoryPageCounts> {
  const data = await managerData<RoleMemoryPageCounts | RoleMemoryPayload>(
    `/api/roles/${encodeURIComponent(roleId)}/memory?counts=1`
  );
  if (typeof data.recent === "number" && typeof data.consolidated === "number") {
    const counts = data as RoleMemoryPageCounts;
    return {
      recent: counts.recent,
      consolidated: counts.consolidated,
      archived: typeof counts.archived === "number" ? counts.archived : 0,
      consolidationRuns: typeof counts.consolidationRuns === "number" ? counts.consolidationRuns : 0
    };
  }
  const payload = data as RoleMemoryPayload;
  const archived = payload.archived || payload.recent.filter((memory) => Boolean(memory.consolidatedAt));
  const recent = payload.archived ? payload.recent : payload.recent.filter((memory) => !memory.consolidatedAt);
  return {
    recent: recent.length,
    consolidated: payload.consolidated.length,
    archived: archived.length,
    consolidationRuns: 0
  };
}

export async function loadRoleMemoryPage(
  roleId: string,
  kind: RoleMemoryKind,
  cursor = "",
  limit = 24,
  query = ""
): Promise<RoleMemoryPage> {
  const params = new URLSearchParams({ kind, limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  if (query.trim()) params.set("query", query.trim());
  const data = await managerData<RoleMemoryPage | RoleMemoryPayload>(
    `/api/roles/${encodeURIComponent(roleId)}/memory?${params.toString()}`
  );
  if ("items" in data) {
    return {
      ...data,
      counts: {
        ...data.counts,
        archived: typeof data.counts.archived === "number" ? data.counts.archived : 0
      }
    };
  }

  const start = Math.max(0, Number.parseInt(cursor, 10) || 0);
  const pageLimit = Math.min(100, Math.max(1, Math.floor(limit) || 24));
  const archived = data.archived || data.recent.filter((memory) => Boolean(memory.consolidatedAt));
  const recent = data.archived ? data.recent : data.recent.filter((memory) => !memory.consolidatedAt);
  const source = kind === "archived" ? archived : kind === "consolidated" ? data.consolidated : recent;
  const items = source.filter((item) => knowledgeItemMatchesQuery(item, query));
  const end = Math.min(items.length, start + pageLimit);
  return {
    items: items.slice(start, end),
    total: items.length,
    nextCursor: end < items.length ? String(end) : "",
    counts: {
      recent: recent.length,
      consolidated: data.consolidated.length,
      archived: archived.length,
      consolidationRuns: 0
    }
  };
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
