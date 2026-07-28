import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || fallback;
}

function walkJson(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? walkJson(target) : entry.isFile() && entry.name.endsWith(".json") ? [target] : [];
  });
}

function currentStep(plan) {
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  return steps.find((step) => String(step?.id || "") === String(plan.currentStepId || ""))
    || steps.find((step) => String(step?.status || "") === "进行中");
}

function needsApproval(plan, step) {
  const response = String(step?.approvalRequest?.responseStatus || "");
  if (["approved", "rejected", "cancelled"].includes(response)) return false;
  if (step?.approvalRequest && typeof step.approvalRequest === "object") return true;
  return [step?.id, step?.title, step?.waitingFor, step?.blockedBy, plan.waitingFor, plan.blockedBy]
    .some((value) => /(等待|待|需要|未经).*(审批|批准|授权|审核|人工决策)|^(审批|批准|授权|审核|人工决策)/i.test(String(value || "").replace(/\s+/g, "")));
}

function inferApprover(plan, step, contract) {
  const explicit = String(contract.approver || step?.waitingFor || plan.waitingFor || "").trim();
  if (explicit) return explicit.replace(/(批准|审批|确认|回复|答复).*$/u, "").trim() || explicit;
  return "";
}

function migratePlan(plan) {
  if (!["进行中", "未开始"].includes(String(plan.status || ""))) return null;
  const step = currentStep(plan);
  if (!step || !needsApproval(plan, step)) return null;
  const contract = step.approvalRequest && typeof step.approvalRequest === "object" ? { ...step.approvalRequest } : {};
  const approver = inferApprover(plan, step, contract);
  const approverLabel = approver || "审批人待确认";
  const decision = String(contract.request || contract.recommendation || step.title || plan.currentStep || plan.title).trim();
  const blockedBy = `${approverLabel}，尚未批准、调整或否决：${decision}`;
  const nextStep = {
    ...step,
    waitingFor: String(step.waitingFor || plan.waitingFor || (approver
      ? `${approver}给出明确审批结论`
      : "确认具体审批人并取得明确审批结论")).trim(),
    isBlocked: true,
    blockedBy,
    approvalRequest: {
      ...contract,
      approver: approver || undefined,
      request: String(contract.request || decision).trim(),
      recommendation: String(contract.recommendation || "").trim() || undefined,
      alternatives: Array.isArray(contract.alternatives) ? contract.alternatives : [],
      reason: String(contract.reason || step.detail || plan.focus || "需要取得明确审批结论后才能实施。" ).trim(),
      files: Array.isArray(contract.files) ? contract.files : [],
      commands: Array.isArray(contract.commands) ? contract.commands : [],
      changes: Array.isArray(contract.changes) ? contract.changes : [],
      validation: Array.isArray(contract.validation) ? contract.validation : [],
      rollback: Array.isArray(contract.rollback) ? contract.rollback : [],
      outOfScope: Array.isArray(contract.outOfScope) ? contract.outOfScope : [],
      requestedAt: String(contract.requestedAt || "").trim() || undefined,
      sourceMessageId: String(contract.sourceMessageId || "").trim() || undefined,
      feedbackId: String(contract.feedbackId || "").trim() || undefined,
      responseStatus: contract.responseStatus === "changes_requested" ? "changes_requested" : "pending"
    }
  };
  const migrated = {
    ...plan,
    waitingFor: String(plan.waitingFor || nextStep.waitingFor).trim(),
    isBlocked: true,
    blockedBy,
    steps: plan.steps.map((item) => item === step ? nextStep : item)
  };
  if (JSON.stringify(migrated) === JSON.stringify(plan)) return null;
  return { ...migrated, updatedAt: new Date().toISOString() };
}

const roleDirArgument = argValue("--role-dir");
if (!roleDirArgument) {
  process.stderr.write("Missing required --role-dir=<path>. Run without --apply for a dry-run first.\n");
  process.exit(2);
}
const roleDir = path.resolve(roleDirArgument);
const plansRoot = path.join(roleDir, "plans", "items");
const apply = process.argv.includes("--apply");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupRoot = path.join(roleDir, "migration-backups", `approval-blocking-${stamp}`);
const changes = [];

for (const file of walkJson(plansRoot)) {
  const originalText = fs.readFileSync(file, "utf8");
  let plan;
  try { plan = JSON.parse(originalText); } catch { continue; }
  const migrated = migratePlan(plan);
  if (!migrated || JSON.stringify(migrated) === JSON.stringify(plan)) continue;
  const step = currentStep(migrated);
  changes.push({
    file: path.relative(roleDir, file),
    planId: String(migrated.id || ""),
    blockedBy: String(step?.blockedBy || migrated.blockedBy || ""),
    approverRecorded: Boolean(step?.approvalRequest?.approver),
    sourceRecorded: Boolean(step?.approvalRequest?.sourceMessageId || step?.approvalRequest?.feedbackId)
  });
  if (!apply) continue;
  const relative = path.relative(roleDir, file);
  const backupFile = path.join(backupRoot, relative);
  fs.mkdirSync(path.dirname(backupFile), { recursive: true });
  fs.copyFileSync(file, backupFile);
  fs.writeFileSync(file, `${JSON.stringify(migrated, null, 2)}\n`, "utf8");
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  mode: apply ? "apply" : "dry-run",
  roleDir,
  changedPlanCount: changes.length,
  backupRoot: apply && changes.length ? backupRoot : null,
  missingApproverCount: changes.filter((item) => !item.approverRecorded).length,
  missingSourceCount: changes.filter((item) => !item.sourceRecorded).length,
  changes
}, null, 2)}\n`);
