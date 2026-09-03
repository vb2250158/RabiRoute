import type { PlanItem, PlanStep } from "./roleKnowledge.js";
import { currentPlanStep } from "./roleKnowledge.js";
import {
  planStatusDefinition,
  planStatusKeyForRole,
  resolvePersonaPlanStatus,
  type PersonaPlanWorkflow
} from "./personaPlanWorkflow.js";

const QA_STEP_TOKEN = /(?:^|[-_:])(?:qa|verify)(?:[-_:]|$)/i;
const PACKAGE_STEP_ID = /(?:^|[-_:])(?:package|packaging|pack|bundle|build|artifact)(?:[-_:]|$)/i;
const PACKAGE_WAIT = /(?:合包|打包|目标包(?:身份)?|包身份|进包|包产物|构建(?:完成|结果|产物)?|package(?:\s+(?:build|artifact|identity))?|build\s+artifact|included?\s+in\s+(?:the\s+)?(?:target\s+)?(?:build|package))/i;
const NON_PACKAGE_WAIT = /(?:qa|测试|验收|审批|批准|授权|方案|资料|说明|文档|素材|答复|回复|确认需求|test|acceptance|approval|approve|document|material)/i;
const LEGACY_GLOBAL_PACKAGE_GATE = /(?:等待|依赖|尚待)[^\n]{0,32}(?:正式|统一|全局)?[^\n]{0,24}(?:打包|合包)(?:任务|现场|门禁)|(?:禁止|暂停)[^\n]{0,80}(?:unity|svn)[^\n]{0,80}(?:构建|上传|发布|qa)/i;
const MAIN_DELIVERY_EVIDENCE = /(?:Main[^\n]{0,80}(?:r\d+|revision|已提交|已同步)|Main[\s/、→-]+Release[^\n]{0,80}(?:同步|提交|r\d+))/i;
const RELEASE_DELIVERY_EVIDENCE = /(?:Release[^\n]{0,80}(?:r\d+|revision|已提交|已同步|不适用|无需)|Main[\s/、→-]+Release[^\n]{0,80}(?:同步|提交|r\d+)|(?:不适用|无需)[^\n]{0,40}Release)/i;
const ART_DELIVERY_EVIDENCE = /(?:Art[^\n]{0,80}(?:r\d+|revision|已提交|已同步|不适用|无需|无[^\n]{0,20}目标)|(?:无|没有)[^\n]{0,24}Art[^\n]{0,24}目标|(?:不适用|无需)[^\n]{0,40}Art)/i;
const MATCHING_TEST_EVIDENCE = /(?:测试|test|EditMode|PlayMode|静态|CLI|非\s*Unity|TRX)[^\n]{0,80}(?:\b\d+\s*\/\s*\d+\b|\b\d+\s+passed\b|passed\s*=\s*\d+|matched\s*=\s*\d+|通过|failed\s*=\s*0)/i;
const SVN_COMMIT_EVIDENCE = /(?:SVN[^\n]{0,80}(?:提交|commit|r\d+)|(?:提交|commit)[^\n]{0,80}(?:SVN|r\d+)|r\d+[^\n]{0,80}(?:SVN|提交|commit))/i;
const CONFLICT_TYPES_CLEAR_EVIDENCE = /(?:(?:无|没有)[^\n]{0,12}文本[\s/、，和及、]*属性[\s/、，和及、]*树冲突[^\n]{0,24}(?:obstruction|阻碍|障碍)|文本[\s/、，和及、]*属性[\s/、，和及、]*树冲突[^\n]{0,24}(?:均无|都无|不存在)[^\n]{0,24}(?:obstruction|阻碍|障碍)[^\n]{0,12}(?:也无|不存在|无))/i;
const SHOW_UPDATES_CLEAR_EVIDENCE = /(?:svn\s+status\s+--show-updates|show-updates)[^\n]{0,48}(?:无|没有|no)[^\n]{0,12}\*/i;
const TARGET_PACKAGE_COMPLETED = /(?:目标包|统一包|正式包|安卓包|PC\s*包|Android|package|build)[^\n]{0,120}(?:已完成|构建完成|已交付|完成交付|产物已生成)|(?:已完成|构建完成|已交付|完成交付|产物已生成)[^\n]{0,120}(?:目标包|统一包|正式包|安卓包|PC\s*包|Android|package|build)/i;
const TARGET_PACKAGE_INCLUDED = /(?:纳入|包含|含有|进包|included?)[^\n]{0,120}(?:r\d+|revision|本轮|改动|计划)|(?:r\d+|revision|本轮|改动|计划)[^\n]{0,120}(?:纳入|包含|含有|进包|included?)/i;
const TARGET_PACKAGE_IDENTITY = /(?:\b\d+\.\d+\.\d+(?:\.\d+)?\b|\br\d+\b|revision\s*[:=#]?\s*\d+|build(?:Id)?\s*[:=#]?\s*[\w.-]+|package(?:Id)?\s*[:=#]?\s*[\w.-]+)/i;
const NEGATED_PACKAGE_PROOF = /(?:历史|旧包|上一包|不足以证明|不能证明|无法证明|未证明|尚未完成|未完成|未纳入|未包含|未进包|not\s+(?:yet\s+)?(?:completed|included)|insufficient\s+proof)/i;
const QA_PACKAGE_DELIVERY_EVIDENCE = /(?:QA[^\n]{0,80}(?:文件|包)[^\n]{0,80}(?:已发送|已回读|sent)|(?:文件|包)[^\n]{0,80}(?:已发送|已回读|sent)[^\n]{0,80}QA)/i;
const REVISION_IDENTITY = /\br\d+\b/i;

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

function completedDeliveryEvidence(plan: PlanItem, step: PlanStep): string {
  return [
    plan.currentStep,
    plan.nextAction,
    [step.title, step.detail, step.waitingFor].map(text).filter(Boolean).join(" "),
    ...plan.steps
      .filter((item) => item.id !== step.id && item.status === "已完成")
      .map((item) => [item.title, item.detail, item.waitingFor].map(text).filter(Boolean).join(" "))
  ].map(text).filter(Boolean).join("\n");
}

function hasCompletedDeliverySync(plan: PlanItem, step: PlanStep): boolean {
  const evidence = completedDeliveryEvidence(plan, step);
  return MAIN_DELIVERY_EVIDENCE.test(evidence)
    && RELEASE_DELIVERY_EVIDENCE.test(evidence)
    && ART_DELIVERY_EVIDENCE.test(evidence)
    && MATCHING_TEST_EVIDENCE.test(evidence)
    && SVN_COMMIT_EVIDENCE.test(evidence)
    && CONFLICT_TYPES_CLEAR_EVIDENCE.test(evidence)
    && SHOW_UPDATES_CLEAR_EVIDENCE.test(evidence);
}

function isStructuredQaStep(plan: PlanItem, step: PlanStep): boolean {
  const value = text(step.id);
  if (/^(?:investigate|fix|implement|develop|repair)(?:[-_:]|$)/i.test(value)) return false;
  if (!QA_STEP_TOKEN.test(value) || PACKAGE_STEP_ID.test(value)) return false;
  if (/(?:^|[-_:])qa(?:[-_:]|$)/i.test(value)) return true;
  return /(?:QA|验收|acceptance)/i.test([
    plan.currentStep,
    plan.nextAction,
    step.title,
    step.detail,
    step.waitingFor
  ].map(text).filter(Boolean).join("\n"));
}

function packageLifecycleSteps(plan: PlanItem): PlanStep[] {
  return plan.steps.filter((step) => PACKAGE_STEP_ID.test(text(step.id)) && !QA_STEP_TOKEN.test(text(step.id)));
}

function isDeliveryEvidenceReconcileStep(step: PlanStep): boolean {
  return /^program-verify-(?:[\w-]*(?:delivery|freeze|package|contract)[\w-]*)$/i.test(text(step.id));
}

function hasUnresolvedPackageWait(plan: PlanItem): boolean {
  return packageLifecycleSteps(plan)
    .some((step) => {
      const evidence = [step.title, step.detail, step.waitingFor].map(text).filter(Boolean).join("\n");
      return PACKAGE_WAIT.test(evidence)
        && !NEGATED_PACKAGE_PROOF.test(evidence)
        && !TARGET_PACKAGE_COMPLETED.test(evidence);
    });
}

export function planHasPackageLifecycle(plan: PlanItem): boolean {
  return packageLifecycleSteps(plan).length > 0;
}

export function planIsStructuredQaPhase(plan: PlanItem): boolean {
  const step = currentPlanStep(plan);
  return Boolean(step && step.status === "进行中" && isStructuredQaStep(plan, step));
}

export function planHasTargetPackageInclusionEvidence(plan: PlanItem): boolean {
  const current = currentPlanStep(plan);
  const currentQaEvidence = current && isStructuredQaStep(plan, current)
    ? [plan.currentStep, plan.nextAction, current.title, current.detail, current.waitingFor]
        .map(text)
        .filter(Boolean)
        .join("\n")
    : "";
  return packageLifecycleSteps(plan)
    .filter((step) => step.status === "已完成")
    .some((step) => {
      const packageEvidence = [step.title, step.detail, step.waitingFor].map(text).filter(Boolean).join("\n");
      const evidence = [packageEvidence, currentQaEvidence].filter(Boolean).join("\n");
      if (!packageEvidence || NEGATED_PACKAGE_PROOF.test(packageEvidence) || !TARGET_PACKAGE_IDENTITY.test(evidence)) {
        return false;
      }
      const completionProven = TARGET_PACKAGE_COMPLETED.test(evidence) || Boolean(currentQaEvidence);
      const inclusionProven = TARGET_PACKAGE_INCLUDED.test(evidence)
        || (REVISION_IDENTITY.test(packageEvidence) && QA_PACKAGE_DELIVERY_EVIDENCE.test(currentQaEvidence));
      return completionProven && inclusionProven;
    });
}

export function planIsWaitingForQaAcceptance(plan: PlanItem, workflow: PersonaPlanWorkflow): boolean {
  return plan.status === planStatusKeyForRole(workflow, "waitingQa");
}

function legacyPlanIsWaitingForPackage(plan: PlanItem): boolean {
  if (String(plan.status) !== "进行中") return false;
  const step = currentPlanStep(plan);
  if (!step || step.status !== "进行中") return false;
  if (planIsStructuredQaPhase(plan) && planHasPackageLifecycle(plan)) {
    return priorStepsAreComplete(plan, step)
      && hasCompletedDeliverySync(plan, step)
      && !planHasTargetPackageInclusionEvidence(plan);
  }
  if (isStructuredQaStep(plan, step)) return false;
  if (isDeliveryEvidenceReconcileStep(step)
    && hasCompletedDeliverySync(plan, step)
    && hasUnresolvedPackageWait(plan)
    && !planHasTargetPackageInclusionEvidence(plan)) {
    return true;
  }
  if (!PACKAGE_STEP_ID.test(text(step.id))) return false;
  if (!hasCompletedDeliverySync(plan, step)) return false;
  const waiting = packageWaitingText(plan, step);
  if (waiting.length === 0 || waiting.some((value) => NON_PACKAGE_WAIT.test(value))) return false;
  return waiting.some((value) => PACKAGE_WAIT.test(value));
}

export function planIsWaitingForPackage(plan: PlanItem, workflow: PersonaPlanWorkflow): boolean {
  return plan.status === planStatusKeyForRole(workflow, "waitingPackage");
}

export type PackageGateMigration = {
  action: "waiting_package" | "resume_running";
  plan: PlanItem;
};

export function migrateLegacyPackageGatePlan(
  plan: PlanItem,
  workflow: PersonaPlanWorkflow,
  updatedAt = new Date().toISOString()
): PackageGateMigration | null {
  if (resolvePersonaPlanStatus(workflow, plan.status)?.matchedBy !== "legacyAlias") return null;
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
  const waitingPackage = legacyPlanIsWaitingForPackage(migrated);
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
    plan: {
      ...migrated,
      status: waitingPackage
        ? planStatusKeyForRole(workflow, "waitingPackage")
        : (step as PlanStep & { workPhase?: string }).workPhase === "execution"
          ? planStatusKeyForRole(workflow, "execution")
          : planStatusKeyForRole(workflow, "analysis")
    }
  };
}
