import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { parse, compileScript } from "@vue/compiler-sfc";
import { approvalPanelExpanded, approvalQuestionSignature, matchingApprovalFeedback } from "../src/approvalFeedbackUi";
import type { RolePlan, RolePlanApprovalContract, RolePlanFeedback } from "../src/types";

const contract: RolePlanApprovalContract = { request: "Update settings", reason: "Requested", files: [], commands: [], changes: [], validation: [], rollback: [], outOfScope: [] };
function fixture(): RolePlan {
  return { id: "plan", currentStepId: "step", status: "approval", presentation: { approval: { state: "approved", enabled: true, stepId: "step", contract, missing: [] } }, approval: { count: 0 } } as RolePlan;
}
function feedback(): RolePlanFeedback {
  return { id: "feedback", stepId: "step", kind: "approval_suggestion", author: "user", createdAt: "2026-01-01", text: "do not infer choices", attachments: [], planAttachments: [], formData: { questions: [], approvalContract: contract, answers: { "approval-decision": { optionId: "suggest", text: "Change this" } }, text: "extra text" } } as RolePlanFeedback;
}
test("approved collapses the complete approval panel unless explicitly editing", () => {
  const plan = fixture();
  assert.equal(approvalPanelExpanded(plan, false), false);
  assert.equal(approvalPanelExpanded(plan, true), true);
  plan.presentation.approval.state = "ready";
  assert.equal(approvalPanelExpanded(plan, false), true);
});
test("draft identity ignores status and receipt metadata but invalidates questions and contract changes", () => {
  const plan = fixture();
  const original = approvalQuestionSignature("role", plan, []);
  plan.status = "analysis";
  plan.presentation.approval.state = "ready";
  plan.presentation.approval.contract = { ...contract, responseStatus: "approved", feedbackId: "receipt" };
  assert.equal(approvalQuestionSignature("role", plan, []), original);
  assert.notEqual(approvalQuestionSignature("other-role", plan, []), original);
  assert.notEqual(approvalQuestionSignature("role", plan, [{ id: "new", prompt: "New?", required: true, options: [] }]), original);
  plan.presentation.approval.contract = { ...contract, request: "Different request" };
  assert.notEqual(approvalQuestionSignature("role", plan, []), original);
});
test("restores only matching structured feedback, never guesses legacy choices", () => {
  const plan = fixture();
  const saved = feedback();
  plan.approval.records = [saved];
  assert.equal(matchingApprovalFeedback(plan, [])?.formData?.text, "extra text");
  assert.equal(matchingApprovalFeedback(plan, [])?.formData?.answers["approval-decision"].optionId, "suggest");
  plan.approval.records = [{ ...saved, formData: undefined }];
  assert.equal(matchingApprovalFeedback(plan, []), undefined);
  plan.approval.records = [{ ...saved, formData: { ...saved.formData!, approvalContract: { ...contract, request: "Old" } } }];
  assert.equal(matchingApprovalFeedback(plan, []), undefined);
  plan.approval.records = [{ ...saved, stepId: "other" }];
  assert.equal(matchingApprovalFeedback(plan, []), undefined);
});
test("page compiles with full-panel disclosure, authoritative reload and structured submission", () => {
  const source = fs.readFileSync(new URL("../src/pages/RoleKnowledgePage.vue", import.meta.url), "utf8");
  const { descriptor, errors } = parse(source);
  assert.deepEqual(errors, []);
  assert.doesNotThrow(() => compileScript(descriptor, { id: "approval-page", inlineTemplate: true }));
  assert.match(source, /await reloadFeedbackPlan\(plan.id, selectedRoleId\)/);
  assert.match(source, /await reloadFeedbackPlan\(planId, selectedRoleId\)/);
  assert.match(source, /formData,\s+reuseFeedbackId,\s+attachments,/);
  assert.match(source, /approvalPending\[plan.id\] \|\| feedbackDeliveryPending\(plan\)/);
  assert.match(source, /保留原审批附件/);
  assert.match(source, /const focusedPlanId = computed/);
});

import ts from "typescript";
test("approval attachment picker accepts nine small files and retains byte limits",()=>{
 const source=fs.readFileSync(new URL("../src/pages/RoleKnowledgePage.vue",import.meta.url),"utf8"),parsed=parse(source).descriptor.scriptSetup!;
 const ast=ts.createSourceFile("picker.ts",parsed.content,ts.ScriptTarget.Latest,true),fn=ast.statements.find((s):s is ts.FunctionDeclaration=>ts.isFunctionDeclaration(s)&&s.name?.text==="addApprovalFiles");assert(fn);
 const emitted=ts.transpileModule(fn.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
 const drafts:Record<string,Array<{size:number}>>={},errors:string[]=[];let nextId=0;
 const add=new Function("approvalPending","approvalAttachmentsFor","approvalAttachmentError","PLAN_FEEDBACK_ATTACHMENT_MAX_BYTES","PLAN_FEEDBACK_ATTACHMENTS_MAX_BYTES","attachmentDraftId","markRaw","clipboardAttachmentName","approvalAttachments","approvalNotices",emitted+";return addApprovalFiles;")({},(id:string)=>drafts[id]||[],(_id:string,_zh:string,en:string)=>errors.push(en),10*1024*1024,25*1024*1024,()=>String(++nextId),(file:File)=>file,()=>"clipboard.txt",drafts,{}) as (id:string,files:File[])=>void;
 add("plan",Array.from({length:9},(_,i)=>new File(["x"],"note-"+i+".txt",{type:"text/plain"})));assert.equal((drafts.plan||[]).length,9);assert.deepEqual(errors,[]);
 add("plan",[new File([new Uint8Array(10*1024*1024+1)],"large.bin")]);assert.match(errors.at(-1)!,/exceeds 10 MB/);assert.equal((drafts.plan||[]).length,9);
 add("plan",Array.from({length:3},(_,i)=>new File([new Uint8Array(9*1024*1024)],"part-"+i+".bin")));assert.match(errors.at(-1)!,/25 MB in total/);assert.equal((drafts.plan||[]).length,9);
});
