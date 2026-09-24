import type http from "node:http";
import { getPlanAsync, type PlanItem } from "../roleKnowledge.js";
import { listPlanFeedbackAsync } from "../planFeedbackStore.js";
import { ensurePersonaPlanWorkflow } from "../personaPlanWorkflow.js";
import { planWorkspaceIdentity, parseWorkspacePlanQuery } from "../planWorkspaceQuery.js";
import { planAgentStatusService } from "./planAgentStatus.js";
import { managerKnowledgePageWorkerPool } from "./managerReadWorkerPool.js";
import { evaluateAdvance, parseAdvancePolicy, PlanAdvanceStore, type AdvanceTrigger } from "./planAdvancePolicy.js";
import type { AgentThreadRequest, AgentThreadRequestResult } from "../agentThreads.js";

type Context = { roleDir: (id: string) => string; send: (request: AgentThreadRequest) => Promise<AgentThreadRequestResult> };
const busySessions = new Set<string>();
const json = (response: http.ServerResponse, status: number, data: unknown) => { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(data)); };
async function bodyOf(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 1024 * 1024) throw new Error("Request too large."); chunks.push(Buffer.from(chunk)); }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request.");
  return value as Record<string, unknown>;
}

/** Rabi owns policies and reservations; hosts provide their scoped session inventory. */
export function handlePlanAdvanceApi(request: http.IncomingMessage, url: URL, response: http.ServerResponse, context: Context): boolean {
  const match = /^\/api\/roles\/([^/]+)\/plan-advance\/(settings|check|run)$/.exec(url.pathname);
  if (!match) return false;
  void (async () => {
    const roleId = decodeURIComponent(match[1]!); const dir = context.roleDir(roleId);
    const body = request.method === "GET" ? {} : await bodyOf(request);
    const workspace = planWorkspaceIdentity(String(body.workspace ?? url.searchParams.get("workspace") ?? ""));
    if (!workspace) throw new Error("Absolute workspace required.");
    const store = new PlanAdvanceStore(dir); const workflow = ensurePersonaPlanWorkflow(dir).workflow;
    if (match[2] === "settings") {
      if (request.method === "PUT") store.save(workspace, parseAdvancePolicy(body.policy, workflow), String(body.revision || ""));
      else if (request.method !== "GET") throw new Error("Unsupported method.");
      json(response, 200, { code: 0, data: { ...store.policy(workspace), statuses: workflow.statuses, roles: workflow.roles } }); return;
    }
    if (request.method !== "POST") throw new Error("POST required.");
    const sessionIds = body.sessionIds;
    if (!Array.isArray(sessionIds) || sessionIds.length > 20000 || sessionIds.some(id => typeof id !== "string" || !id)) throw new Error("Session inventory required.");
    const trigger = String(body.trigger || "manual") as AdvanceTrigger;
    if (!["manual", "startup", "change", "idle", "due"].includes(trigger)) throw new Error("Invalid trigger.");
    const { policy } = store.policy(workspace);
    if (!Object.values(policy.rules).some(rule => rule.enabled)) { json(response, 200, { code: 0, data: { items: [], nextCursor: "" } }); return; }
    let ids: string[]; let nextCursor = "";
    if (body.planIds !== undefined) {
      if (!Array.isArray(body.planIds) || body.planIds.length > 20 || body.planIds.some(id => typeof id !== "string" || !id)) throw new Error("Invalid plan identities.");
      ids = [...new Set(body.planIds)] as string[];
    } else {
      const page = await managerKnowledgePageWorkerPool.queryRolePlanPage<{ items: Array<{ id: string }>; nextCursor?: string }>(dir, parseWorkspacePlanQuery({
        cursor: body.cursor ?? "", limit: 20, statuses: Object.entries(policy.rules).filter(([, rule]) => rule.enabled).map(([key]) => key),
        bindingScope: { agentType: "dsh", workspace, sessionIds }
      }));
      ids = page.items.map(item => item.id); nextCursor = page.nextCursor || "";
    }
    const doc = store.read();
    const plans = (await Promise.all(ids.map(id => getPlanAsync(dir, id)))).filter((plan): plan is PlanItem => !!plan);
    const evaluated = await Promise.all(plans.map(async plan => {
      const item = evaluateAdvance({ plan, workflow, policy, workspace, trigger, now: Date.now(), feedback: await listPlanFeedbackAsync(dir, plan.id), receipt: doc.receipts[store.receiptKey(workspace, plan.id)] });
      if (!sessionIds.includes(plan.taskBinding?.sessionId)) { item.eligible = false; item.reason = "binding_mismatch"; }
      return item;
    }));
    const statuses = await planAgentStatusService.inspectPlans(plans.filter(plan => evaluated.find(item => item.planId === plan.id)?.eligible));
    for (const item of evaluated) if (item.eligible) {
      const status = statuses.find(row => row.planId === item.planId)?.taskAgent;
      if (status?.sessionStatus !== "idle" || status.agentStatus !== "idle") { item.eligible = false; item.reason = status?.working ? "session_running" : "session_unavailable"; }
    }
    if (match[2] === "check") { json(response, 200, { code: 0, data: { items: evaluated, nextCursor } }); return; }
    const expected = body.expected;
    if (!expected || typeof expected !== "object" || Array.isArray(expected)) throw new Error("Checked fingerprints required.");
    const results: Array<{ planId: string; state: string; reason?: string }> = [];
    const groups = new Map<string, typeof evaluated>();
    for (const item of evaluated) {
      if (!item.eligible || (expected as Record<string, unknown>)[item.planId] !== item.fingerprint) { results.push({ planId: item.planId, state: "skipped", reason: item.reason || "changed_since_check" }); continue; }
      const group = groups.get(item.sessionId!) || []; group.push(item); groups.set(item.sessionId!, group);
    }
    const currentPlans = [...groups.values()].map(group => plans.find(plan => plan.id === group[0]!.planId)!);
    const currentStatuses = await planAgentStatusService.inspectPlans(currentPlans);
    const currentBySession = new Map(currentStatuses.map(status => [status.taskAgent.threadId, status.taskAgent]));
    // Each host session receives one combined work package; multiple windows share the reservation.
    for (const [sessionId, group] of groups) {
      if (busySessions.has(sessionId)) { for (const item of group) results.push({ planId: item.planId, state: "skipped", reason: "session_reserved" }); continue; }
      const current = currentBySession.get(sessionId);
      if (current?.sessionStatus !== "idle") { for (const item of group) results.push({ planId: item.planId, state: "skipped", reason: current?.working ? "session_running" : "session_unavailable" }); continue; }
      busySessions.add(sessionId);
      const reserved: Array<{ planId: string; id: string }> = [];
      let deliveryAttempted = false;
      try {
        for (const item of group) {
          const plan = (await getPlanAsync(dir, item.planId))!;
          if (!plan || (plan.storageRevision || plan.updatedAt) !== (plans.find(row => row.id === item.planId)!.storageRevision || plans.find(row => row.id === item.planId)!.updatedAt)) throw new Error("Plan changed before dispatch.");
          const receipt = store.reserve(workspace, plan, item.fingerprint, item.rule!, Date.now()); reserved.push({ planId: item.planId, id: receipt.id });
        }
        const plan = plans.find(row => row.id === group[0]!.planId)!;
        const request: AgentThreadRequest = { action: "send", agentAdapter: "dsh", dshDeliveryMode: "queue", threadId: sessionId, cwd: workspace, dshBaseUrl: plan.taskBinding?.baseUrl,
          deliveryId: reserved[0]!.id, createIfMissing: false, prompt: group.map(item => `GET /api/roles/${encodeURIComponent(roleId)}/plans/${encodeURIComponent(item.planId)}\n${item.prompt}`).join("\n\n---\n\n"),
          messageSource: { type: "system", eventType: "plan_advance", eventName: "Rabi plan advance", eventId: reserved[0]!.id }, responsePolicy: "none" };
        deliveryAttempted = true;
        const result = await context.send(request);
        if (result.statusCode >= 300 || result.data.ok === false || !["delivered", "sent"].includes(String(result.data.status))) throw new Error("Delivery outcome requires verification: " + String(result.data.status));
        for (const receipt of reserved) { store.finish(workspace, receipt.planId, receipt.id, "accepted"); results.push({ planId: receipt.planId, state: "accepted" }); }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        for (const receipt of reserved) {
          if (deliveryAttempted) store.finish(workspace, receipt.planId, receipt.id, "uncertain", reason);
          else store.cancelUnsent(workspace, receipt.planId, receipt.id);
        }
        for (const item of group) results.push({ planId: item.planId, state: deliveryAttempted ? "uncertain" : "skipped", reason });
      } finally { busySessions.delete(sessionId); }
    }
    json(response, 200, { code: 0, data: { items: results } });
  })().catch(error => json(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
  return true;
}
