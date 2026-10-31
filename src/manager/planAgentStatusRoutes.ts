import path from "node:path";
import type http from "node:http";
import { getPlan, listPlans, listPlanHistory, type PlanItem } from "../roleKnowledge.js";
import { planAgentStatusService, type PlanAgentRole, type PlanAgentStatusService } from "./planAgentStatus.js";
import { preparePersonaResourceAdmission, type PersonaResourceIdentity } from "./personaResourceAdmission.js";

export type PlanAgentStatusContext = {
  roleDir(roleId: string): string;
  identity?(): PersonaResourceIdentity;
  service?: PlanAgentStatusService;
  listPlans?: (roleDir: string) => PlanItem[];
  getPlan?: (roleDir: string, planId: string) => PlanItem | null;
  listPlanHistory?: typeof listPlanHistory;
};

/** The native status service retains adapter scanning and original plan/history bindings. */
export function createPlanAgentStatusOwner(context: PlanAgentStatusContext) {
  return {
    prepare(request: http.IncomingMessage, roleId: string, signal?: AbortSignal) {
      const admission = preparePersonaResourceAdmission(request, signal, context.identity);
      const roleDir = context.roleDir(roleId);
      const assertCurrent = () => {
        admission();
        if (path.resolve(context.roleDir(roleId)) !== path.resolve(roleDir)) throw Object.assign(new Error("Persona directory changed while using the original plan owner."), { statusCode: 409 });
      };
      const service = context.service ?? planAgentStatusService;
      return {
        async inspect(rawIds: string[]) {
          assertCurrent();
          const ids = new Set(rawIds.map(value => value.trim()).filter(Boolean));
          const plans = (context.listPlans ?? listPlans)(roleDir).filter(plan => !ids.size || ids.has(plan.id));
          const missingPlanIds = [...ids].filter(id => !plans.some(plan => plan.id === id));
          let items;
          try { items = await service.inspectPlans(plans); }
          catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { statusCode: 500 }); }
          assertCurrent();
          return { items, missingPlanIds };
        },
        async open(planId: string, raw: unknown) {
          assertCurrent();
          // Preserve the native request semantics; unknown display fields never replace stored actors.
          const body = raw as { role?: PlanAgentRole; historyId?: string };
          const role = body.role === "secretary" ? "secretary" : body.role === "task" ? "task" : null;
          if (!role && !body.historyId) throw new Error("role or historyId is required.");
          if (body.historyId && (typeof body.historyId !== "string" || body.historyId.length > 256 || body.role)) throw new Error("Provide only a valid historyId for history navigation.");
          const plan = (context.getPlan ?? getPlan)(roleDir, planId);
          if (!plan) throw Object.assign(new Error(`Plan not found: ${planId}`), { statusCode: 404 });
          let data;
          assertCurrent();
          if (body.historyId) {
            const record = (context.listPlanHistory ?? listPlanHistory)(roleDir, planId).find(item => item.id === body.historyId);
            if (!record) throw Object.assign(new Error("Plan history record not found."), { statusCode: 404 });
            if (!service.openHistoryActor) throw new Error("History Agent navigation is unavailable.");
            data = await service.openHistoryActor(record);
          } else data = await service.openPlanAgent(plan, role!);
          try { assertCurrent(); }
          catch (error) { if (error && typeof error === 'object') Object.assign(error, { uncertain: true }); throw error; }
          return data;
        }
      };
    }
  };
}
