import assert from "node:assert/strict";
import test from "node:test";
import { buildRoleKnowledgeContextView, planMemoryApiHint, requiredReadLines } from "./roleKnowledgeContext.js";
import { DEFAULT_FOCUSED_CONTEXT_INJECTION, DEFAULT_LEGACY_CONTEXT_INJECTION } from "../roleKnowledge.js";

test("role hints guide discovery through active contracts and preserve local recovery", () => {
  const hints = planMemoryApiHint("Rabi Test").join("\n");
  assert.match(hints, /当前角色为 Rabi Test/);
  assert.match(hints, /GET \/api\/search\?q=/);
  assert.match(hints, /label、excerpt、coverage 和 handle/);
  assert.match(hints, /scope=operations/);
  assert.match(hints, /GET \/api\/agent\/operations/);
  assert.match(hints, /\{operationId\}\?view=input/);
  assert.match(hints, /inputSources、relatedOperations 和 examples/);
  assert.match(hints, /调用合同指定的业务接口/);
  assert.match(hints, /写后回读/);
  assert.match(hints, /Idempotency-Key/);
  assert.match(hints, /强 ETag \/ If-Match/);
  assert.match(hints, /局部来源或操作失败.*继续其它可用入口/);
  assert.match(hints, /不确定写入先查原 ID/);
  assert.match(hints, /发现、连接或检索工具不可用.*继续原任务/);
  assert.match(hints, /明确的宿主能力缺口.*当前授权选择适用工具/);
  assert.doesNotMatch(hints, /sourceCapability|approvalRequest|roles\.waitingPackage|\/plans\/\{planId\}/);
});

test('related content hints preserve grounding without blocking independent work on an unavailable source', () => {
  const lines = requiredReadLines([{type:'role_skill',id:'pack',title:'打包流程',summary:'读取实际流程',score:20,endpoint:'/api/roles/example/skills/pack',revisionAt:'2026-11-17T00:00:00Z'}]).join('\n');
  assert.match(lines, /按 GET 路径读取原文并确认适用范围/);
  assert.match(lines, /读取失败时记录一次实际原因.*继续原任务/);
  assert.match(lines, /缺少依据的事实标明未确认/);
  assert.match(lines, /确需用户决定的业务问题再询问/);
  assert.match(lines, /\/api\/roles\/example\/skills\/pack/);
  assert.doesNotMatch(lines, /之前，必须|先向用户追问|无法读取时停止/);
});

test("focused and legacy modes share active discovery while topic documents remain supplementary", () => {
  const knowledge = {
    contextInjection: DEFAULT_FOCUSED_CONTEXT_INJECTION,
    agentInterfaceDocPath: "runtime/docs/rabi-agent-interfaces.md",
    requiredReadItems: [], matchedSkills: [], activePlans: [], activeSkills: [], recentMemories: [], matchedItems: []
  } as unknown as Parameters<typeof buildRoleKnowledgeContextView>[1];
  const focused = buildRoleKnowledgeContextView("Rabi Test", knowledge).apiHintLines;
  const legacy = buildRoleKnowledgeContextView("Rabi Test", { ...knowledge, contextInjection: DEFAULT_LEGACY_CONTEXT_INJECTION }).apiHintLines;
  assert.deepEqual(focused.slice(0, legacy.length), legacy);
  assert.match(focused.join("\n"), /runtime\/docs\/rabi-agent-interfaces.md/);
  assert.match(focused.join("\n"), /按需补充背景.*活动接口合同为准/);
  assert.doesNotMatch(focused.join("\n"), /无法读取时停止该操作|禁止.*GUI|禁用.*GUI/);
  assert.ok(Buffer.byteLength(focused.join("\n"), "utf8") < 2200);
});
