import path from "node:path";
import type http from "node:http";
import { getPlanAsync, type PlanItem } from "../roleKnowledge.js";
import { listPlanFeedbackAsync } from "../planFeedbackStore.js";
import type { PersonaPlanWorkflowReadResult } from "../personaPlanWorkflow.js";
import { planWorkspaceIdentity, parseWorkspacePlanQuery } from "../planWorkspaceQuery.js";
import { planAgentStatusService } from "./planAgentStatus.js";
import { managerKnowledgePageWorkerPool } from "./managerReadWorkerPool.js";
import { evaluateAdvance, parseAdvancePolicy, PlanAdvanceStore, type AdvanceTrigger } from "./planAdvancePolicy.js";
import type { AgentThreadRequest, AgentThreadRequestResult } from "../agentThreads.js";

import { preparePersonaResourceAdmission, type PersonaResourceIdentity } from "./personaResourceAdmission.js";
import type { PlanAgentStatusService } from "./planAgentStatus.js";

export type PlanAdvanceContext = {
  roleDir(id: string): string;
  send(request: AgentThreadRequest): Promise<AgentThreadRequestResult>;
  identity?(): PersonaResourceIdentity;
  service?: PlanAgentStatusService;
  worker?: Pick<typeof managerKnowledgePageWorkerPool, 'run' | 'queryRolePlanPage'>;
  getPlanAsync?: typeof getPlanAsync;
  listFeedback?: typeof listPlanFeedbackAsync;
};
const busySessions = new Set<string>();

/** Rabi owns policies and reservations; hosts provide their scoped session inventory. */
export function createPlanAdvanceOwner(context: PlanAdvanceContext) {
  return {
    prepare(request: http.IncomingMessage, roleId: string, signal?: AbortSignal) {
      const admission = preparePersonaResourceAdmission(request, signal, context.identity);
      const dir = context.roleDir(roleId);
      const assertCurrent = () => {
        admission();
        if (path.resolve(context.roleDir(roleId)) !== path.resolve(dir)) throw Object.assign(new Error("Persona directory changed while using the original plan owner."), { statusCode: 409 });
      };
      const worker = context.worker ?? managerKnowledgePageWorkerPool;
      const service = context.service ?? planAgentStatusService;
      let mutationStarted = false;
      return {
        async execute(action: 'settings.read' | 'settings.save' | 'check' | 'run', raw: unknown, queryWorkspace?: string | null) {
          try {
            assertCurrent();
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error("Invalid request.");
            const body = raw as Record<string, unknown>;
            const workspace = planWorkspaceIdentity(String(body.workspace ?? queryWorkspace ?? ""));
            if (!workspace) throw new Error("Absolute workspace required.");
            // Startup migration owns workflow materialization; request handlers only read
            // through the bounded storage process so slow shared files cannot stop /health.
            const workflowResult = await worker.run<PersonaPlanWorkflowReadResult | null>({ type: "role_plan_workflow", roleDir: dir });
            assertCurrent();
            if (!workflowResult) throw new Error("Role plan workflow is warming; retry shortly.");
            const store = new PlanAdvanceStore(dir); const workflow = workflowResult.workflow;
            if (action === "settings.read" || action === "settings.save") {
              if (action === "settings.save") {
                const policy = parseAdvancePolicy(body.policy, workflow);
                assertCurrent(); store.save(workspace, policy, String(body.revision || "")); mutationStarted = true;
              }
              const doc = await store.readAsync(); assertCurrent();
              return { ...store.policy(workspace, doc), statuses: workflow.statuses, roles: workflow.roles };
            }
            const sessionIds = body.sessionIds;
            if (!Array.isArray(sessionIds) || sessionIds.length > 20000 || sessionIds.some(id => typeof id !== "string" || !id)) throw new Error("Session inventory required.");
            const trigger = String(body.trigger || "manual") as AdvanceTrigger;
            if (!["manual", "startup", "change", "idle", "due"].includes(trigger)) throw new Error("Invalid trigger.");
            const { policy } = store.policy(workspace, await store.readAsync()); assertCurrent();
            if (!Object.values(policy.rules).some(rule => rule.enabled)) { assertCurrent(); return { items: [], total: 0, nextCursor: "" }; }
            let ids: string[]; let nextCursor = ""; let total = 0;
            if (body.planIds !== undefined) {
              if (!Array.isArray(body.planIds) || body.planIds.length > 20 || body.planIds.some(id => typeof id !== "string" || !id)) throw new Error("Invalid plan identities.");
              ids = [...new Set(body.planIds)] as string[];
              total = ids.length;
            } else {
              const page = await worker.queryRolePlanPage<{ items: Array<{ id: string }>; total: number; nextCursor?: string }>(dir, parseWorkspacePlanQuery({
                cursor: body.cursor ?? "", limit: 20, statuses: Object.entries(policy.rules).filter(([, rule]) => rule.enabled).map(([key]) => key),
                bindingScope: { agentType: "dsh", workspace, sessionIds }
              }));
              assertCurrent();
              ids = page.items.map(item => item.id); total = page.total; nextCursor = page.nextCursor || "";
            }
            const doc = await store.readAsync(); assertCurrent();
            const plans = (await Promise.all(ids.map(id => (context.getPlanAsync ?? getPlanAsync)(dir, id)))).filter((plan): plan is PlanItem => !!plan);
            assertCurrent();
            const evaluated = await Promise.all(plans.map(async plan => {
              const item = evaluateAdvance({ plan, workflow, policy, workspace, trigger, now: Date.now(), feedback: await (context.listFeedback ?? listPlanFeedbackAsync)(dir, plan.id), receipt: doc.receipts[store.receiptKey(workspace, plan.id)] });
              if (!sessionIds.includes(plan.taskBinding?.sessionId)) { item.eligible = false; item.reason = "binding_mismatch"; }
              return item;
            }));
            assertCurrent();
            const statuses = await service.inspectPlans(plans.filter(plan => evaluated.find(item => item.planId === plan.id)?.eligible));
            assertCurrent();
            for (const item of evaluated) if (item.eligible) {
              const status = statuses.find(row => row.planId === item.planId)?.taskAgent;
              if (status?.sessionStatus !== "idle" || status.agentStatus !== "idle") { item.eligible = false; item.reason = status?.working ? "session_running" : "session_unavailable"; }
            }
            if (action === "check") return { items: evaluated, total, nextCursor };
            const expected = body.expected;
            if (!expected || typeof expected !== "object" || Array.isArray(expected)) throw new Error("Checked fingerprints required.");
            const results: Array<{ planId: string; state: string; reason?: string }> = [];
            const groups = new Map<string, typeof evaluated>();
            for (const item of evaluated) {
              if (!item.eligible || (expected as Record<string, unknown>)[item.planId] !== item.fingerprint) { results.push({ planId: item.planId, state: "skipped", reason: item.reason || "changed_since_check" }); continue; }
              const group = groups.get(item.sessionId!) || []; group.push(item); groups.set(item.sessionId!, group);
            }
            const currentPlans = [...groups.values()].map(group => plans.find(plan => plan.id === group[0]!.planId)!);
            const currentStatuses = await service.inspectPlans(currentPlans);
            assertCurrent();
            const currentBySession = new Map(currentStatuses.map(status => [status.taskAgent.threadId, status.taskAgent]));
            // Each host session receives one combined work package; multiple windows share the reservation.
            for (const [sessionId, group] of groups) {
              assertCurrent();
              if (busySessions.has(sessionId)) { for (const item of group) results.push({ planId: item.planId, state: "skipped", reason: "session_reserved" }); continue; }
              const current = currentBySession.get(sessionId);
              if (current?.sessionStatus !== "idle") { for (const item of group) results.push({ planId: item.planId, state: "skipped", reason: current?.working ? "session_running" : "session_unavailable" }); continue; }
              busySessions.add(sessionId);
              const reserved: Array<{ planId: string; id: string }> = [];
              let deliveryAttempted = false;
              try {
                for (const item of group) {
                  const plan = (await (context.getPlanAsync ?? getPlanAsync)(dir, item.planId))!;
                  assertCurrent();
                  if (!plan || (plan.storageRevision || plan.updatedAt) !== (plans.find(row => row.id === item.planId)!.storageRevision || plans.find(row => row.id === item.planId)!.updatedAt)) throw new Error("Plan changed before dispatch.");
                  const receipt = store.reserve(workspace, plan, item.fingerprint, item.rule!, Date.now()); reserved.push({ planId: item.planId, id: receipt.id });
                }
                const plan = plans.find(row => row.id === group[0]!.planId)!;
                const request: AgentThreadRequest = { action: "send", agentAdapter: "dsh", dshDeliveryMode: "queue", threadId: sessionId, cwd: workspace, dshBaseUrl: plan.taskBinding?.baseUrl,
                  deliveryId: reserved[0]!.id, createIfMissing: false, prompt: group.map(item => `GET /api/roles/${encodeURIComponent(roleId)}/plans/${encodeURIComponent(item.planId)}\n${item.prompt}`).join("\n\n---\n\n"),
                  messageSource: { type: "system", eventType: "plan_advance", eventName: "Rabi plan advance", eventId: reserved[0]!.id }, responsePolicy: "none" };
                assertCurrent();
                deliveryAttempted = true; mutationStarted = true;
                const result = await context.send(request);
                assertCurrent();
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
            assertCurrent(); return { items: results };
          } catch (error) {
            if (mutationStarted && error && typeof error === 'object') Object.assign(error, { uncertain: true });
            throw error;
          }
        }
      };
    }
  };
}
