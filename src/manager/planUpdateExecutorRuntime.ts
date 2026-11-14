import { planUpdatePrimitives } from "../roleKnowledge.js";
import { createPlanUpdatePreparation } from "../plugins/io.rabiroute.manager.persona/worker/plan-update.mjs";
import type { PlanUpdateExecutorDescriptor, PlanUpdatePreparation } from "./planUpdateExecutor.js";

const preparations = new Map<string, Promise<PlanUpdatePreparation>>();
const bootstrapPreparation = createPlanUpdatePreparation(planUpdatePrimitives);

/** Entries originate in the current validated service or the retained-package resolver. */
export function loadPlanUpdatePreparation(executor?: PlanUpdateExecutorDescriptor): Promise<PlanUpdatePreparation> {
  if (!executor) return Promise.resolve(bootstrapPreparation);
  let pending = preparations.get(executor.entryUrl);
  if (!pending) {
    pending = import(executor.entryUrl).then(module => {
      const preparation = module.createPlanUpdatePreparation(planUpdatePrimitives) as PlanUpdatePreparation;
      if (!preparation || typeof preparation.prepare !== "function"
        || typeof preparation.projectHistory !== "function" || typeof preparation.projectPlan !== "function") {
        throw new Error("The selected Persona package lacks the plan-update executor contract.");
      }
      return preparation;
    });
    preparations.set(executor.entryUrl, pending);
    void pending.catch(() => { if (preparations.get(executor.entryUrl) === pending) preparations.delete(executor.entryUrl); });
  }
  return pending;
}
