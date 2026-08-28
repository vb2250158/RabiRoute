import assert from "node:assert/strict";
import test from "node:test";
import type { RolePlan } from "../src/types.js";
import {
  loadPlanAgentStatuses,
  loadPlanHistory,
  loadPendingMemoryConsolidationRunCount,
  loadRoleMemoryCounts,
  loadRoleMemoryPage,
  loadRolePlan,
  loadRolePlanPage,
  loadRolePlanPreview,
  normalizeRolePlanFromManager,
  openPlanAgentTask
} from "../src/roleKnowledgeClient.js";

function plan(presentation?: RolePlan["presentation"]): RolePlan {
  return {
    id: "plan",
    title: "Plan",
    focus: "Plan",
    status: "进行中",
    attachments: [],
    steps: [],
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    keywords: [],
    presentation: presentation as RolePlan["presentation"],
    approval: { count: 0 }
  };
}

test("WebGUI loads a plan revision history by plan id", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests.push(String(input));
    return new Response(JSON.stringify({
      code: 0,
      data: {
        count: 1,
        records: [{
          id: "history-1",
          planId: "plan",
          kind: "archived",
          recordedAt: "2026-08-20T00:00:00.000Z",
          after: { id: "plan", title: "Plan", focus: "Plan", status: "已归档", attachments: [], steps: [], createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z", keywords: [] }
        }]
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const records = await loadPlanHistory("Rabi", "plan");
    assert.equal(records[0]?.kind, "archived");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(requests[0], "/api/roles/Rabi/plans/plan/history");
});

test("WebGUI preserves Manager stages and does not derive a second stage when presentation is absent", () => {
  const managerStage = normalizeRolePlanFromManager(plan({
    status: "暂停",
    tone: "paused",
    sortBucket: 9,
    views: ["current", "plans"],
    palette: { accent: "#ef6c52", background: "#fff1ed", foreground: "#b42318" },
    approval: { state: "none", enabled: false, label: "无需审批", helper: "", missing: [] }
  }));
  const missingPresentation = normalizeRolePlanFromManager(plan(undefined));

  assert.equal(managerStage.presentation.status, "暂停");
  assert.equal(managerStage.presentation.tone, "paused");
  assert.equal(missingPresentation.presentation.status, "状态未知");
  assert.equal(missingPresentation.presentation.tone, "unknown");
});

test("WebGUI preserves the Manager-owned QA acceptance label, tone, and palette", () => {
  const qa = normalizeRolePlanFromManager(plan({
    status: "等待 QA",
    tone: "qa",
    sortBucket: 1,
    views: ["current", "plans"],
    palette: { accent: "#8e63c7", background: "#f3e8ff", foreground: "#7e22ce" },
    approval: { state: "none", enabled: false, label: "无需审批", helper: "", missing: [] }
  }));

  assert.equal(qa.presentation.status, "等待 QA");
  assert.equal(qa.presentation.tone, "qa");
  assert.deepEqual(qa.presentation.palette, {
    accent: "#8e63c7",
    background: "#f3e8ff",
    foreground: "#7e22ce"
  });
});

test("WebGUI requests only the active plan view and current search query", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests.push(String(input));
    return new Response(JSON.stringify({
      code: 0,
      data: {
        items: [],
        total: 0,
        nextCursor: "",
        counts: {
          total: 0,
          current: 0,
          plans: 0,
          archived: 0,
          blocked: 0,
          qa: 0,
          active: 0,
          stages: {
            executing: 0,
            qa: 0,
            waitingPackage: 0,
            waitingExternal: 0,
            approval: 0,
            pending: 0,
            paused: 0,
            completed: 0,
            archived: 0
          }
        }
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await loadRolePlanPage("Rabi", "", 8, {
      view: "current",
      query: "掉线 性能",
      sort: "updated",
      statuses: ["进行中", "待审批"],
      tags: ["WebGUI", "性能"]
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 1);
  const requestUrl = new URL(requests[0]!, "http://127.0.0.1");
  assert.equal(requestUrl.searchParams.get("view"), "current");
  assert.equal(requestUrl.searchParams.get("query"), "掉线 性能");
  assert.equal(requestUrl.searchParams.get("sort"), "updated");
  assert.deepEqual(requestUrl.searchParams.getAll("status"), ["进行中", "待审批"]);
  assert.deepEqual(requestUrl.searchParams.getAll("tag"), ["WebGUI", "性能"]);
});

test("WebGUI omits repeated facets from later plan pages", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests.push(String(input));
    return new Response(JSON.stringify({
      code: 0,
      data: {
        items: [],
        total: 0,
        nextCursor: "",
        facets: { statuses: [], tags: [] },
        counts: {
          total: 0,
          current: 0,
          plans: 0,
          archived: 0,
          blocked: 0,
          qa: 0,
          active: 0,
          stages: {
            executing: 0,
            qa: 0,
            waitingPackage: 0,
            waitingExternal: 0,
            approval: 0,
            pending: 0,
            paused: 0,
            completed: 0,
            archived: 0
          }
        }
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await loadRolePlanPage("Rabi", "8", 50, { includeFacets: false });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(new URL(requests[0]!, "http://127.0.0.1").searchParams.get("facets"), "0");
});

test("WebGUI sends importance and urgency plan sorting to Manager", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests.push(String(input));
    return new Response(JSON.stringify({
      code: 0,
      data: {
        items: [],
        total: 0,
        nextCursor: "",
        facets: { statuses: [], tags: [] },
        counts: {
          total: 0,
          current: 0,
          plans: 0,
          archived: 0,
          blocked: 0,
          qa: 0,
          active: 0,
          stages: {
            executing: 0,
            qa: 0,
            waitingPackage: 0,
            waitingExternal: 0,
            approval: 0,
            pending: 0,
            paused: 0,
            completed: 0,
            archived: 0
          }
        }
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await loadRolePlanPage("Rabi", "", 8, { sort: "importance" });
    await loadRolePlanPage("Rabi", "", 8, { sort: "urgency" });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(new URL(requests[0]!, "http://127.0.0.1").searchParams.get("sort"), "importance");
  assert.equal(new URL(requests[1]!, "http://127.0.0.1").searchParams.get("sort"), "urgency");
});

test("WebGUI batches plan Agent status reads and opens only the selected bound role", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/open")) {
      return new Response(JSON.stringify({
        code: 0,
        data: { opened: true, threadId: "thread-1", threadTitle: "Plan task", workspace: "C:/repo" }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      code: 0,
      data: {
        items: [{
          planId: "plan-1",
          checkedAt: "2026-08-07T00:00:00.000Z",
          taskAgent: {
            role: "task",
            configured: true,
            agentType: "codex",
            threadId: "thread-1",
            threadTitle: "Plan task",
            workspace: "C:/repo",
            working: false,
            agentStatus: "idle",
            sessionStatus: "idle",
            canOpen: true,
            checkedAt: "2026-08-07T00:00:00.000Z"
          }
        }],
        missingPlanIds: ["missing-plan"]
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const status = await loadPlanAgentStatuses("Rabi Active", ["plan-1", "plan-1", "missing-plan"]);
    assert.deepEqual(status.items.map((item) => item.planId), ["plan-1"]);
    assert.deepEqual(status.missingPlanIds, ["missing-plan"]);
    assert.deepEqual(status.failedPlanIds, []);
    await openPlanAgentTask("Rabi Active", "plan-1", "secretary");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 2);
  const statusUrl = new URL(requests[0]!.url, "http://127.0.0.1");
  assert.equal(statusUrl.pathname, "/api/roles/Rabi%20Active/plan-agents/status");
  assert.deepEqual(statusUrl.searchParams.getAll("planId"), ["plan-1", "missing-plan"]);
  assert.equal(requests[1]!.init?.method, "POST");
  assert.equal(requests[1]!.init?.body, JSON.stringify({ role: "secretary" }));
});

test("WebGUI returns the first eight summaries without waiting for plan details", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const request = String(input);
    requests.push(request);
    return new Response(JSON.stringify({
      code: 0,
      data: {
        items: [{
          id: "plan-1",
          title: "Plan 1",
          status: "进行中",
          currentStepId: "step-2",
          currentStepPreview: { id: "step-2", title: "Current step", status: "进行中" },
          currentStepPosition: 2,
          attachmentCount: 3,
          stepCount: 5,
          completedStepCount: 1,
          detailLevel: "summary",
          createdAt: "2026-07-30T00:00:00.000Z",
          updatedAt: "2026-07-30T00:00:00.000Z",
          keywords: [],
          presentation: plan().presentation
        }],
        total: 1,
        nextCursor: "",
        counts: {
          total: 1,
          current: 1,
          plans: 1,
          archived: 0,
          blocked: 0,
          qa: 0,
          active: 1,
          stages: {
            executing: 1,
            qa: 0,
            waitingPackage: 0,
            approval: 0,
            manualVerification: 0,
            paused: 0,
            completed: 0,
            archived: 0
          }
        },
        facets: { statuses: [], tags: [] }
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const result = await loadRolePlanPage("Rabi", "", 8, { view: "plans" });
    assert.equal(result.items[0]?.detailLevel, "summary");
    assert.equal(result.items[0]?.currentStepPreview?.title, "Current step");
    assert.equal(result.items[0]?.stepCount, 5);
    assert.equal(result.items[0]?.attachments.length, 0);
    assert.equal(result.items[0]?.steps.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 1);
  assert.match(requests[0]!, /detail=summary/);
});

test("WebGUI reads attachment previews separately from full expanded plan details", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const request = String(input);
    requests.push(request);
    const preview = request.includes("detail=preview");
    return new Response(JSON.stringify({
      code: 0,
      data: {
        ...plan(),
        focus: preview ? "Preview body" : "Full body",
        attachments: [{ id: "image", kind: "image", name: "preview.png", size: 42, mimeType: "image/png", sha256: "a".repeat(64) }],
        steps: preview ? [] : [{ id: "step-1", title: "Full step", status: "进行中" }],
        currentStepPreview: { id: "step-1", title: "Current step", status: "进行中", detail: "Visible before expand" },
        attachmentCount: 1,
        stepCount: 1,
        completedStepCount: 0,
        detailLevel: preview ? "preview" : "full"
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const preview = await loadRolePlanPreview("Rabi", "plan-1");
    const full = await loadRolePlan("Rabi", "plan-1");
    assert.equal(preview.detailLevel, "preview");
    assert.equal(preview.attachments.length, 1);
    assert.equal(preview.steps.length, 0);
    assert.equal(full.detailLevel, "full");
    assert.equal(full.steps[0]?.title, "Full step");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests[0], "/api/roles/Rabi/plans/plan-1?detail=preview");
  assert.equal(requests[1], "/api/roles/Rabi/plans/plan-1");
});

test("WebGUI requests a bounded page for only the visible memory category", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests.push(String(input));
    return new Response(JSON.stringify({
      code: 0,
      data: {
        items: [],
        total: 0,
        nextCursor: "",
        counts: { recent: 182, consolidated: 4, archived: 36, consolidationRuns: 0 }
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const page = await loadRoleMemoryPage("Rabi", "recent", "24", 24, "掉线");
    assert.equal(page.counts.recent, 182);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 1);
  const requestUrl = new URL(requests[0]!, "http://127.0.0.1");
  assert.equal(requestUrl.pathname, "/api/roles/Rabi/memory");
  assert.equal(requestUrl.searchParams.get("kind"), "recent");
  assert.equal(requestUrl.searchParams.get("cursor"), "24");
  assert.equal(requestUrl.searchParams.get("limit"), "24");
  assert.equal(requestUrl.searchParams.get("query"), "掉线");
});

test("WebGUI can load memory tab counts without loading memory cards", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests.push(String(input));
    return new Response(JSON.stringify({
      code: 0,
      data: { recent: 120, consolidated: 31, archived: 68, consolidationRuns: 6 }
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    assert.deepEqual(await loadRoleMemoryCounts("Rabi"), {
      recent: 120,
      consolidated: 31,
      archived: 68,
      consolidationRuns: 6
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 1);
  const requestUrl = new URL(requests[0]!, "http://127.0.0.1");
  assert.equal(requestUrl.pathname, "/api/roles/Rabi/memory");
  assert.equal(requestUrl.searchParams.get("counts"), "1");
  assert.equal(requestUrl.searchParams.has("limit"), false);
});

test("memory count loading remains compatible with a Manager that returns the legacy full payload", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    code: 0,
    data: {
      recent: [
        { id: "m1", title: "A", focus: "", content: "A", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z", keywords: [] },
        { id: "m2", title: "B", focus: "", content: "B", createdAt: "2026-08-02T00:00:00.000Z", updatedAt: "2026-08-02T00:00:00.000Z", keywords: [] }
      ],
      consolidated: [
        { id: "c1", title: "C", focus: "", content: "C", createdAt: "2026-08-03T00:00:00.000Z", updatedAt: "2026-08-03T00:00:00.000Z", keywords: [] }
      ]
    }
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    assert.deepEqual(await loadRoleMemoryCounts("Rabi"), {
      recent: 2,
      consolidated: 1,
      archived: 0,
      consolidationRuns: 0
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("WebGUI accepts the legacy full-memory response until Manager reloads", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    code: 0,
    data: {
      recent: [
        { id: "m1", title: "普通记录", focus: "", content: "其他内容", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z", keywords: [] },
        { id: "m2", title: "掉线调查", focus: "", content: "Manager", createdAt: "2026-08-02T00:00:00.000Z", updatedAt: "2026-08-02T00:00:00.000Z", keywords: [] }
      ],
      consolidated: []
    }
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const page = await loadRoleMemoryPage("Rabi", "recent", "", 24, "掉线");
    assert.deepEqual(page.items.map((item) => item.id), ["m2"]);
    assert.equal(page.total, 1);
    assert.equal(page.nextCursor, "");
    assert.deepEqual(page.counts, { recent: 2, consolidated: 0, archived: 0, consolidationRuns: 0 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("legacy full-memory responses classify consolidated recent sources as archived", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    code: 0,
    data: {
      recent: [
        { id: "m-active", title: "近期", focus: "", content: "A", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z", keywords: [] },
        { id: "m-archived", title: "归档", focus: "", content: "B", createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z", consolidatedAt: "2026-08-02T00:00:00.000Z", keywords: [] }
      ],
      consolidated: []
    }
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const archived = await loadRoleMemoryPage("Rabi", "archived");
    assert.deepEqual(archived.items.map((item) => item.id), ["m-archived"]);
    assert.deepEqual(archived.counts, { recent: 1, consolidated: 0, archived: 1, consolidationRuns: 0 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("WebGUI loads pending memory consolidation counts through the shared Manager envelope", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ input: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ input: String(input), init });
    return new Response(JSON.stringify({
      code: 0,
      data: [{ status: "requested" }, { status: "completed" }, { status: "requested" }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    assert.equal(await loadPendingMemoryConsolidationRunCount("Rabi"), 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0]!.input, "http://127.0.0.1").pathname, "/api/roles/Rabi/memory/consolidation-runs");
  assert.equal(requests[0]!.init?.cache, "no-store");
});

test("pending memory consolidation counts reject a Manager envelope error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    code: -1,
    message: "Manager unavailable"
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    await assert.rejects(() => loadPendingMemoryConsolidationRunCount("Rabi"), /Manager unavailable/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
