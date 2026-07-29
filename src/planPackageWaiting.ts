import type { PlanItem, PlanStep } from "./roleKnowledge.js";
import { currentPlanStep } from "./roleKnowledge.js";

const QA_STEP_ID = /^(?:qa|verify)(?:[-_:].*)?$/i;
const PACKAGE_STEP_ID = /(?:^|[-_:])(?:package|packaging|pack|bundle|build|artifact)(?:[-_:]|$)/i;
const PACKAGE_WAIT = /(?:合包|打包|目标包(?:身份)?|包身份|进包|包产物|构建(?:完成|结果|产物)?|package(?:\s+(?:build|artifact|identity))?|build\s+artifact|included?\s+in\s+(?:the\s+)?(?:target\s+)?(?:build|package))/i;
const NON_PACKAGE_WAIT = /(?:qa|测试|验收|审批|批准|授权|方案|资料|说明|文档|素材|答复|回复|确认需求|test|acceptance|approval|approve|document|material)/i;
const LEGACY_GLOBAL_PACKAGE_GATE = /(?:等待|依赖|尚待)[^\n]{0,32}(?:正式|统一|全局)?[^\n]{0,24}(?:打包|合包)(?:任务|现场|门禁)|(?:禁止|暂停)[^\n]{0,80}(?:unity|svn)[^\n]{0,80}(?:构建|上传|发布|qa)/i;

function text(value: unknown): string {
  return String(value || "").trim();
}

function priorStepsAreComplete(plan: PlanItem, step: PlanStep): boolean {
  const currentIndex = plan.steps.findIndex((item) => item.id === step.id);
  return currentIndex >= 0 && plan.steps.slice(0, currentIndex).every((item) => item.status === "已完成");
}

function packageWaitingText(plan: PlanItem, step: PlanStep): string[] {
  return [
    text(plan.waitingFor),
    text(step.waitingFor),
    text(plan.blockedBy),
    text(step.blockedBy)
  ].filter(Boolean);
}

export function planIsWaitingForPackage(plan: PlanItem): boolean {
  if (plan.status !== "进行中") return false;
  const step = currentPlanStep(plan);
  if (!step || step.status !== "进行中" || QA_STEP_ID.test(text(step.id))) return false;
  if (!PACKAGE_STEP_ID.test(text(step.id)) || !priorStepsAreComplete(plan, step)) return false;
  const waiting = packageWaitingText(plan, step);
  if (waiting.length === 0 || waiting.some((value) => NON_PACKAGE_WAIT.test(value))) return false;
  return waiting.some((value) => PACKAGE_WAIT.test(value));
}

export type PackageGateMigration = {
  action: "waiting_package" | "resume_running";
  plan: PlanItem;
};

export function migrateLegacyPackageGatePlan(
  plan: PlanItem,
  updatedAt = new Date().toISOString()
): PackageGateMigration | null {
  if (plan.status !== "进行中") return null;
  const step = currentPlanStep(plan);
  if (!step) return null;
  const gateText = [text(plan.blockedBy), text(step.blockedBy)].filter(Boolean).join("\n");
  if (!LEGACY_GLOBAL_PACKAGE_GATE.test(gateText)) return null;

  let nextStep: PlanStep = { ...step, isBlocked: false, blockedBy: "" };
  let migrated: PlanItem = {
    ...plan,
    isBlocked: false,
    blockedBy: "",
    steps: plan.steps.map((item) => item.id === step.id ? nextStep : item),
    updatedAt
  };
  const waitingPackage = planIsWaitingForPackage(migrated);
  if (!waitingPackage) {
    nextStep = {
      ...nextStep,
      waitingFor: LEGACY_GLOBAL_PACKAGE_GATE.test(text(nextStep.waitingFor)) ? "" : nextStep.waitingFor
    };
    migrated = {
      ...migrated,
      currentStep: LEGACY_GLOBAL_PACKAGE_GATE.test(text(migrated.currentStep)) ? nextStep.title : migrated.currentStep,
      waitingFor: LEGACY_GLOBAL_PACKAGE_GATE.test(text(migrated.waitingFor)) ? "" : migrated.waitingFor,
      steps: migrated.steps.map((item) => item.id === step.id ? nextStep : item)
    };
  }
  return {
    action: waitingPackage ? "waiting_package" : "resume_running",
    plan: migrated
  };
}
