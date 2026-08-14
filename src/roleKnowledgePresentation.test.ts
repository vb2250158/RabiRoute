import assert from "node:assert/strict";
import test from "node:test";
import type { PlanItem, RecentMemoryItem } from "./roleKnowledge.js";
import {
  normalizeRoleMemoryPageLimit,
  normalizeRolePlanPageLimit,
  paginateRoleMemory,
  paginateRolePlans,
  summarizeRolePlan
} from "./roleKnowledgePagination.js";
import { planPresentation, presentPlan, presentPlans, sortKnowledgeByUpdatedAt } from "./roleKnowledgePresentation.js";

function approvalRequest() {
  return {
    approver: "秋雨",
    request: "批准执行列出的改动。",
    recommendation: "批准当前最小改动方案。",
    alternatives: ["要求缩小范围后重新申请", "否决并回到方案设计"],
    reason: "需要人工确认范围。",
    files: [{ path: "src/example.ts", action: "modify" as const, change: "更新示例逻辑。" }],
    commands: [],
    changes: [],
    validation: ["运行 npm test 并确认通过。"],
    rollback: ["验证失败时回退 src/example.ts。"],
    outOfScope: ["不提交、不推送。"],
    requestedAt: "2026-07-28T00:00:00.000Z",
    sourceMessageId: "qq-message-1",
    responseStatus: "pending" as const
  };
}

function plan(patch: Partial<PlanItem> & Pick<PlanItem, "id" | "title">): PlanItem {
  return {
    focus: patch.focus || patch.title,
    status: patch.status || "进行中",
    attachments: patch.attachments || [],
    steps: patch.steps || [],
    createdAt: patch.createdAt || "2026-07-01T00:00:00.000Z",
    updatedAt: patch.updatedAt || "2026-07-01T00:00:00.000Z",
    keywords: patch.keywords || [],
    ...patch,
    id: patch.id,
    title: patch.title
  };
}

test("plan presentation blocks only complete pending approvals and keeps other obstacles running", () => {
  const executableFailure = plan({
    id: "executable-failure",
    title: "Executable failure",
    isBlocked: true,
    blockedBy: "Unity 自动化接口曾超时",
    currentStepId: "fix",
    steps: [{ id: "fix", title: "继续修复", status: "进行中", isBlocked: true, blockedBy: "Unity 自动化接口曾超时" }]
  });
  const blocked = plan({
    id: "blocked",
    title: "Blocked",
    currentStepId: "approve",
    steps: [{
      id: "approve",
      title: "等待批准修改生产文件",
      status: "进行中",
      isBlocked: true,
      blockedBy: "未经批准不得修改",
      approvalRequest: approvalRequest()
    }]
  });
  const awaitingOwnerAnswer = plan({
    id: "awaiting-owner-answer",
    title: "Awaiting owner answer",
    currentStepId: "ask-owner",
    waitingFor: "负责人回复",
    isBlocked: true,
    blockedBy: "负责人尚未批准是否采用当前方案",
    steps: [{
      id: "ask-owner",
      title: "询问负责人并取得明确结果",
      status: "进行中",
      waitingFor: "负责人回复",
      isBlocked: true,
      blockedBy: "负责人尚未批准是否采用当前方案",
      approvalRequest: approvalRequest()
    }]
  });
  const qa = plan({
    id: "qa",
    title: "QA",
    currentStepId: "verify",
    currentStep: "目标包已确认，QA 请求已真实发送，sentMessageId=1355668300，只等待验收结论。",
    steps: [{ id: "verify", title: "等待 QA 验收", status: "进行中", detail: "status=sent, sentMessageId=1355668300" }]
  });
  const qaWithLegacyBlocker = plan({
    id: "qa-with-legacy-blocker",
    title: "QA with legacy blocker",
    currentStepId: "verify",
    currentStep: "专项 QA 已真实发送，sentMessageId=1355668301，等待实机结果。",
    waitingFor: "QA 回传专项结果",
    blockedBy: "QA 尚未回传",
    steps: [{
      id: "verify",
      title: "完成QA并确认剩余决策",
      status: "进行中",
      waitingFor: "QA 专项结果",
      blockedBy: "QA 尚未回传"
    }]
  });
  const approvedImplementation = plan({
    id: "approved-implementation",
    title: "Approved implementation",
    currentStep: "方案已批准，继续执行编译与测试",
    currentStepId: "implement",
    steps: [{ id: "implement", title: "执行编译与测试", status: "进行中" }]
  });
  const implementationMentioningQa = plan({
    id: "implementation-mentioning-qa",
    title: "Implementation mentioning QA",
    currentStepId: "implement-regression-fix",
    currentStep: "修复回归；QA 门禁仍未满足，尚未通知 QA。",
    nextAction: "完成开发验证后再进入 QA。",
    waitingFor: "实现完成后安排 QA",
    steps: [{
      id: "implement-regression-fix",
      title: "修复包含 QA 门禁说明的回归",
      status: "进行中",
      detail: "当前仍是实现与开发验证，尚未通知 QA。",
      waitingFor: "实现完成后安排 QA"
    }]
  });
  const developmentValidation = plan({
    id: "development-validation",
    title: "Development validation",
    currentStepId: "validation-regression",
    currentStep: "开发侧回归验证，完成后再通知 QA。",
    steps: [{ id: "validation-regression", title: "开发验证", status: "进行中", detail: "尚未进入 QA。" }]
  });
  const awaitingPackage = plan({
    id: "plan-1784037085080",
    title: "Main r224817 / Release r224818 package acceptance",
    currentStepId: "package",
    waitingFor: "用户今晚开始打包并由原统一打包任务返回含 r224818 与目标包身份。",
    isBlocked: false,
    blockedBy: "",
    steps: [
      { id: "implement", title: "完成 Main / Release 实现", status: "已完成" },
      {
        id: "matching-tests",
        title: "完成双分支目标测试 3/3",
        detail: "Main→Release 已同步，Art 不适用；SVN 提交 r224818；无文本/属性/树冲突或 obstruction，svn status --show-updates 无 *。",
        status: "已完成"
      },
      { id: "package", title: "等待目标包产物", status: "进行中", waitingFor: "等待目标包身份与进包结果" }
    ]
  });
  const completed = plan({
    id: "completed",
    title: "Completed",
    status: "已完成",
    currentStep: "等待 QA 验收"
  });
  const paused = plan({
    id: "paused",
    title: "Paused",
    status: "暂停",
    currentStepId: "hold",
    isBlocked: true,
    blockedBy: "用户要求暂时跳过",
    steps: [{ id: "hold", title: "保留恢复位置", status: "进行中", isBlocked: true, blockedBy: "用户要求暂时跳过" }]
  });

  assert.equal(planPresentation(blocked).status, "待审批");
  assert.equal(planPresentation(blocked).tone, "blocked");
  assert.deepEqual(planPresentation(blocked).views, ["current", "plans"]);
  assert.deepEqual(planPresentation(blocked).palette, {
    accent: "#ef6c52",
    background: "#fff1ed",
    foreground: "#b42318"
  });
  assert.equal(planPresentation(blocked).approval.enabled, true);
  assert.equal(planPresentation(executableFailure).status, "正在执行");
  assert.equal(planPresentation(executableFailure).tone, "running");
  assert.equal(planPresentation(executableFailure).approval.enabled, false);
  assert.equal(planPresentation(awaitingOwnerAnswer).status, "待审批");
  assert.equal(planPresentation(awaitingOwnerAnswer).tone, "blocked");
  assert.equal(planPresentation(awaitingOwnerAnswer).approval.state, "ready");
  assert.equal(planPresentation(qa).status, "等待 QA 验收");
  assert.equal(planPresentation(qa).tone, "qa");
  assert.deepEqual(planPresentation(qa).palette, {
    accent: "#8e63c7",
    background: "#f3e8ff",
    foreground: "#7e22ce"
  });
  assert.equal(planPresentation(qa).approval.state, "none");
  assert.equal(planPresentation(qa).approval.enabled, false);
  assert.equal(planPresentation(qaWithLegacyBlocker).status, "等待 QA 验收");
  assert.equal(planPresentation(qaWithLegacyBlocker).tone, "qa");
  assert.equal(planPresentation(qaWithLegacyBlocker).approval.enabled, false);
  assert.equal(planPresentation(approvedImplementation).status, "正在执行");
  assert.equal(planPresentation(approvedImplementation).approval.state, "none");
  assert.equal(planPresentation(implementationMentioningQa).status, "正在执行");
  assert.equal(planPresentation(implementationMentioningQa).tone, "running");
  assert.equal(planPresentation(developmentValidation).status, "正在执行");
  assert.equal(planPresentation(developmentValidation).tone, "running");
  assert.equal(planPresentation(awaitingPackage).status, "等待打包");
  assert.equal(planPresentation(awaitingPackage).tone, "waiting_package");
  assert.equal(planPresentation(awaitingPackage).sortBucket, 4);
  assert.deepEqual(planPresentation(awaitingPackage).palette, {
    accent: "#2563eb",
    background: "#eff6ff",
    foreground: "#1d4ed8"
  });
  assert.equal(planPresentation(completed).status, "已完成");
  assert.equal(planPresentation(completed).tone, "done");
  assert.deepEqual(planPresentation(completed).views, ["plans"]);
  assert.deepEqual(planPresentation(completed).palette, {
    accent: "#607d8b",
    background: "#eaf4f7",
    foreground: "#52677a"
  });
  assert.equal(planPresentation(completed).approval.enabled, false);
  assert.equal(planPresentation(paused).status, "暂停");
  assert.equal(planPresentation(paused).tone, "paused");
  assert.deepEqual(planPresentation(paused).views, ["plans"]);
  assert.deepEqual(planPresentation(paused).palette, {
    accent: "#64748b",
    background: "#f1f5f9",
    foreground: "#475569"
  });
  assert.equal(planPresentation(paused).approval.enabled, false);
});

test("plan presentation derives an environment wait from the authoritative current wait fields", () => {
  const item = plan({
    id: "waiting-environment",
    title: "Waiting environment",
    currentStepId: "prepare-test-environment",
    waitingFor: "等待目标测试环境和可用测试账号恢复",
    steps: [{
      id: "prepare-test-environment",
      title: "准备测试环境",
      status: "进行中",
      waitingFor: "等待目标测试环境和可用测试账号恢复"
    }]
  });

  assert.equal(planPresentation(item).status, "等待测试环境");
  assert.equal(planPresentation(item).tone, "waiting_external");
});

test("plan presentation keeps a busy Main Unity owner actionable", () => {
  const item = plan({
    id: "waiting-main-unity-owner",
    title: "Waiting Main Unity owner",
    currentStepId: "implement",
    waitingFor: "等待PID49592及后继Main Unity owner自然退出；恢复产物为Main唯一Prefab回写、Main目标16/16持久XML/log",
    steps: [{
      id: "implement",
      title: "回写Main并完成目标测试",
      status: "进行中",
      waitingFor: "PID49592及后继Main Unity owner自然退出后完成Main回写、16/16重跑和精确提交"
    }]
  });

  assert.equal(planPresentation(item).status, "正在执行");
  assert.equal(planPresentation(item).tone, "running");
});

test("plan presentation keeps shared Unity queues and MCP contention actionable", () => {
  for (const waitingFor of [
    "等待唯一Main Unity工作位完成运行验收",
    "共享PlayMode run仍queued，等待队列释放",
    "正式 Main Unity 运行环境释放后再合并",
    "Main Unity MCP暂不可用，等待恢复"
  ]) {
    const item = plan({
      id: `shared-unity-${waitingFor.length}`,
      title: "Shared Unity remains actionable",
      currentStepId: "verify-runtime",
      waitingFor,
      steps: [{ id: "verify-runtime", title: "继续实现并补运行验收", status: "进行中", waitingFor }]
    });

    assert.equal(planPresentation(item).status, "正在执行");
    assert.equal(planPresentation(item).tone, "running");
  }
});

test("plan presentation distinguishes a material wait from active execution", () => {
  const item = plan({
    id: "waiting-material",
    title: "Waiting material",
    currentStepId: "art-production",
    steps: [{
      id: "art-production",
      title: "接入正式美术资源",
      status: "进行中",
      waitingFor: "等待美术负责人交付正式 PSD、图片素材与资源清单"
    }]
  });

  assert.equal(planPresentation(item).status, "待素材");
  assert.equal(planPresentation(item).tone, "waiting_external");
});

test("plan presentation distinguishes a data wait from active execution", () => {
  const item = plan({
    id: "waiting-information",
    title: "Waiting information",
    currentStepId: "collect-evidence",
    waitingFor: "等待反馈方补充原截图、日志、版本和复现步骤",
    steps: [{ id: "collect-evidence", title: "收集诊断资料", status: "进行中" }]
  });

  assert.equal(planPresentation(item).status, "待资料");
  assert.equal(planPresentation(item).tone, "waiting_external");
});

test("plan presentation uses external receipt as the fallback for an explicit ordinary wait", () => {
  const item = plan({
    id: "waiting-external-receipt",
    title: "Waiting external receipt",
    currentStepId: "implement-validation",
    waitingFor: "等待原业务任务回传目标测试结果",
    steps: [{ id: "implement-validation", title: "实施并验证", status: "进行中" }]
  });

  assert.equal(planPresentation(item).status, "待外部回执");
  assert.equal(planPresentation(item).tone, "waiting_external");
});

test("plan presentation does not treat historical sent screenshot evidence as a current action", () => {
  const item = plan({
    id: "guild-review-sent",
    title: "Guild review sent",
    currentStepId: "waiting-result-car-ui-review",
    currentStep: "运行截图和校对消息均已发送，当前只等待车的校对结果。",
    nextAction: "仅核对 sentMessageId 的回复链；禁止重复发送。",
    waitingFor: "等待车回复两条已发送校对消息的结果",
    steps: [{
      id: "waiting-result-car-ui-review",
      title: "等待车校对公会界面",
      status: "进行中",
      detail: "运行截图已发送，sentMessageId=1060040854，禁止重复发送。",
      waitingFor: "等待车回复已发送消息"
    }]
  });

  assert.equal(planPresentation(item).status, "待外部回执");
  assert.equal(planPresentation(item).tone, "waiting_external");
});

test("plan presentation keeps an explicit run-and-send instruction actionable", () => {
  const item = plan({
    id: "run-and-send-action",
    title: "Run and send action",
    currentStepId: "run-and-send",
    nextAction: "先运行 CLI 检查并发送校对请求，取得 sentMessageId 后再等待结果。",
    waitingFor: "等待负责人提供校对结果",
    steps: [{
      id: "run-and-send",
      title: "运行 CLI 并发送校对请求",
      status: "进行中",
      waitingFor: "等待负责人提供校对结果"
    }]
  });

  assert.equal(planPresentation(item).status, "正在执行");
  assert.equal(planPresentation(item).tone, "running");
});

test("plan presentation enters QA after target-package inclusion even before the QA send receipt", () => {
  const item = plan({
    id: "qa-send-missing",
    title: "QA send is still actionable",
    taskBinding: {
      agentType: "codex",
      sessionId: "qa-task",
      sessionTitle: "[PangHu][QA] Target package acceptance",
      workspace: "C:\\Data\\CottonProject\\PangHu"
    },
    currentStepId: "verify",
    currentStep: "目标包已完成，但尚未取得本轮 QA 发送回执。",
    nextAction: "修复引用锚点后发送 QA 请求并回读 sentMessageId。",
    waitingFor: "等待可引用消息锚点",
    steps: [
      {
        id: "package-target-build",
        title: "完成目标包并证明纳入",
        status: "已完成",
        detail: "Android/PC 1.0.298 统一包已交付，并证明纳入 Release r225253。"
      },
      {
        id: "verify",
        title: "发送 QA 验收请求",
        status: "进行中",
        waitingFor: "等待可引用消息锚点"
      }
    ]
  });

  assert.equal(planPresentation(item).status, "等待 QA 验收");
  assert.equal(planPresentation(item).tone, "qa");
});

test("plan presentation stays blue package waiting when a QA step has no target-package inclusion proof", () => {
  const item = plan({
    id: "qa-before-target-package",
    title: "QA before target package",
    taskBinding: {
      agentType: "codex",
      sessionId: "qa-task-before-package",
      sessionTitle: "PangHu task",
      workspace: "C:\\Data\\CottonProject\\PangHu"
    },
    currentStepId: "send-special-qa",
    currentStep: "等待 QA 结论。",
    waitingFor: "等待 QA 回传",
    steps: [
      {
        id: "sync-submit",
        title: "完成同步提交",
        detail: "Main→Release 已同步，Art 不适用；SVN 提交 r225253；无文本/属性/树冲突或 obstruction，svn status --show-updates 无 *。",
        status: "已完成"
      },
      {
        id: "package-target-build",
        title: "历史包记录",
        detail: "旧包 1.0.297 已完成，但不足以证明纳入本轮 r225253。",
        status: "已完成"
      },
      { id: "send-special-qa", title: "发送专项 QA", status: "进行中" }
    ]
  });

  assert.equal(planPresentation(item).status, "等待打包");
  assert.equal(planPresentation(item).tone, "waiting_package");
});

test("completed package steps may use the current QA step for inclusion and delivery proof", () => {
  const warehouse = plan({
    id: "warehouse-qa",
    title: "Warehouse QA",
    currentStepId: "verify-qa-acceptance",
    currentStep: "等待 QA 验收：TapTap Android 1.0.297(298)，Main/Release r224817/r224818纳入r225189；QA sentMessageId=596755646。",
    steps: [
      { id: "package", title: "确认目标包身份与Release r224818进包证明", status: "已完成" },
      {
        id: "verify-qa-acceptance",
        title: "等待 QA 验收",
        status: "进行中",
        detail: "TapTap Android 1.0.297(298)，Main/Release r224817/r224818纳入r225189；QA sentMessageId=596755646。"
      }
    ]
  });
  assert.equal(planPresentation(warehouse).tone, "qa");

  const unifiedPackage = plan({
    id: "unified-package-qa",
    title: "Unified package QA",
    currentStepId: "verify",
    currentStep: "Android 1.0.300(301) QA文件已发送并回读，等待专项结论。",
    steps: [
      { id: "build", title: "构建r226029 Android与PC产物", status: "已完成" },
      { id: "verify", title: "等待Android QA验证", status: "进行中", detail: "Android 1.0.300(301) QA文件已发送并回读。" }
    ]
  });
  assert.equal(planPresentation(unifiedPackage).tone, "qa");
});

test("plan presentation keeps an available CLI fallback actionable instead of calling it an environment wait", () => {
  const item = plan({
    id: "cli-fallback",
    title: "CLI fallback remains available",
    currentStepId: "verify-with-cli",
    waitingFor: "Unity MCP runner 当前不可用",
    nextAction: "先运行 node --import tsx --test 完成 CLI 合同验证；MCP 恢复后再补编辑器检查",
    steps: [{
      id: "verify-with-cli",
      title: "先完成 CLI 验证并等待编辑器补充检查",
      status: "进行中",
      waitingFor: "Unity MCP runner 当前不可用"
    }]
  });

  assert.equal(planPresentation(item).status, "正在执行");
  assert.equal(planPresentation(item).tone, "running");
});

test("plan presentation describes an explicit Unity prohibition as waiting for renewed authorization", () => {
  const item = plan({
    id: "unity-authorization",
    title: "Unity use requires renewed authorization",
    currentStepId: "await-unity-authorization",
    waitingFor: "用户明确禁止 Unity GUI、MCP、菜单和 PlayMode；等待用户重新授权后再执行",
    steps: [{
      id: "await-unity-authorization",
      title: "等待重新授权 Unity 操作",
      status: "进行中",
      waitingFor: "等待用户重新授权 Unity GUI、MCP、菜单和 PlayMode"
    }]
  });

  assert.equal(planPresentation(item).status, "等待重新授权");
  assert.equal(planPresentation(item).tone, "waiting_external");
});

test("non-content-changing plans keep their real workflow instead of entering package or QA stages", () => {
  const cases = [
    plan({
      id: "investigation",
      title: "Investigation",
      kind: "investigation",
      currentStepId: "investigate-root-cause",
      steps: [{ id: "investigate-root-cause", title: "调查根因并整理证据", status: "进行中" }]
    }),
    plan({
      id: "design-review",
      title: "Design review",
      kind: "design-review",
      currentStepId: "review-design",
      waitingFor: "等待负责人回传设计评审结论",
      steps: [{ id: "review-design", title: "完成设计评审", status: "进行中", waitingFor: "等待负责人回传设计评审结论" }]
    }),
    plan({
      id: "operations",
      title: "Operations",
      kind: "operations",
      currentStepId: "operate-campaign",
      steps: [{ id: "operate-campaign", title: "执行运营安排", status: "进行中" }]
    }),
    plan({
      id: "information",
      title: "Information collection",
      kind: "research",
      currentStepId: "collect-information",
      waitingFor: "等待补充文档、日志和证据",
      steps: [{ id: "collect-information", title: "收集资料", status: "进行中", waitingFor: "等待补充文档、日志和证据" }]
    }),
    plan({
      id: "external-dependency",
      title: "External dependency",
      kind: "coordination",
      currentStepId: "await-external-result",
      waitingFor: "等待外部负责人回传结果",
      steps: [{ id: "await-external-result", title: "跟进外部依赖", status: "进行中", waitingFor: "等待外部负责人回传结果" }]
    }),
    plan({
      id: "control-plane",
      title: "Control-plane maintenance",
      kind: "control-plane",
      currentStepId: "maintain-control-plane",
      steps: [{ id: "maintain-control-plane", title: "维护控制面记录", status: "进行中" }]
    })
  ];

  assert.deepEqual(cases.map((item) => planPresentation(item).status), [
    "正在执行",
    "待外部回执",
    "正在执行",
    "待资料",
    "待外部回执",
    "正在执行"
  ]);
  assert.equal(cases.some((item) => ["qa", "waiting_package"].includes(planPresentation(item).tone)), false);
});

test("approval capability is Manager-owned and follows the current human gate", () => {
  const item = plan({
    id: "approval",
    title: "Approval",
    kind: "human-gate",
    isBlocked: true,
    blockedBy: "秋雨尚未批准当前最小改动方案",
    currentStepId: "decision",
    steps: [{ id: "decision", title: "等待方案确认", status: "进行中", isBlocked: true, blockedBy: "秋雨尚未批准当前最小改动方案", approvalRequest: approvalRequest() }]
  });

  assert.deepEqual(planPresentation(item).approval, {
    state: "ready",
    enabled: true,
    label: "审批执行合同",
    helper: "请先核对审批人、具体决定、推荐与备选、文件、命令、外部变更、验证、回退、排除范围、附件和回执状态，再决定是否批准。",
    stepId: "decision",
    missing: [],
    contract: approvalRequest()
  });
  assert.equal(planPresentation(item).status, "待审批");
  assert.equal(planPresentation(item).tone, "blocked");
});

test("incomplete approvals stay running and disabled until the contract becomes approvable", () => {
  const incomplete = plan({
    id: "approval-incomplete",
    title: "Incomplete approval",
    isBlocked: true,
    blockedBy: "秋雨尚未批准是否执行当前改动",
    currentStepId: "approve",
    steps: [{
      id: "approve",
      title: "等待秋雨审批",
      status: "进行中",
      isBlocked: true,
      blockedBy: "秋雨尚未批准是否执行当前改动",
      approvalRequest: {
        request: "批准当前改动。",
        reason: "需要人工授权。",
        files: [],
        commands: [],
        changes: [],
        validation: [],
        rollback: [],
        outOfScope: []
      }
    }]
  });
  const incompletePresentation = planPresentation(incomplete);
  assert.equal(incompletePresentation.status, "正在执行");
  assert.equal(incompletePresentation.tone, "running");
  assert.equal(incompletePresentation.approval.state, "incomplete");
  assert.equal(incompletePresentation.approval.enabled, false);
  assert.ok(incompletePresentation.approval.missing.includes("approver"));
  assert.ok(incompletePresentation.approval.missing.includes("source"));

  const resolved = plan({
    id: "approval-resolved",
    title: "Resolved approval",
    currentStepId: "implement",
    steps: [{ id: "implement", title: "执行已批准方案", status: "进行中" }]
  });
  assert.equal(planPresentation(resolved).status, "正在执行");
  assert.equal(planPresentation(resolved).approval.state, "none");
});

test("plans awaiting approval sort first, then by Manager presentation status and newest update", () => {
  const sorted = presentPlans([
    plan({ id: "running", title: "Running", updatedAt: "2026-07-24T03:00:00.000Z" }),
    plan({
      id: "waiting-package",
      title: "Waiting package",
      currentStepId: "package",
      waitingFor: "等待目标包身份",
      steps: [
        { id: "implement", title: "完成实现", status: "已完成" },
        {
          id: "matching-tests",
          title: "完成匹配测试",
          detail: "Main→Release 已同步，Art 不适用；SVN 提交 r224818；无文本/属性/树冲突或 obstruction，svn status --show-updates 无 *。",
          status: "已完成"
        },
        { id: "package", title: "等待目标包", status: "进行中" }
      ],
      updatedAt: "2026-07-28T03:00:00.000Z"
    }),
    plan({
      id: "qa-old",
      title: "QA old",
      currentStepId: "verify",
      currentStep: "QA 已真实发送，sentMessageId=1001，只等待验收结论。",
      steps: [{ id: "verify", title: "待 QA 测试", status: "进行中", approvalRequest: approvalRequest() }],
      updatedAt: "2026-07-22T03:00:00.000Z"
    }),
    plan({ id: "blocked-old", title: "Blocked old", isBlocked: true, blockedBy: "External dependency", updatedAt: "2026-07-20T03:00:00.000Z" }),
    plan({
      id: "qa-new",
      title: "QA new",
      currentStepId: "qa-regression",
      waitingFor: "等待 sentMessageId=1002 的验收结论",
      steps: [{ id: "qa-regression", title: "等待验收", status: "进行中" }],
      updatedAt: "2026-07-23T03:00:00.000Z"
    }),
    plan({ id: "blocked-new", title: "Blocked new", isBlocked: true, blockedBy: "Missing build", updatedAt: "2026-07-21T03:00:00.000Z" }),
    plan({ id: "pending", title: "Pending", status: "未开始", updatedAt: "2026-07-25T03:00:00.000Z" }),
    plan({ id: "completed", title: "Completed", status: "已完成", updatedAt: "2026-07-27T03:00:00.000Z" }),
    plan({ id: "archived", title: "Archived", status: "已归档", updatedAt: "2026-07-27T04:00:00.000Z" }),
    plan({
      id: "paused-ready",
      title: "Paused approval",
      status: "暂停",
      currentStepId: "approve",
      steps: [{ id: "approve", title: "等待审批", status: "进行中", approvalRequest: approvalRequest() }],
      updatedAt: "2026-07-26T03:00:00.000Z"
    })
  ]);

  assert.deepEqual(sorted.map((item) => item.id), [
    "qa-old",
    "qa-new",
    "running",
    "blocked-new",
    "blocked-old",
    "waiting-package",
    "pending",
    "completed",
    "archived",
    "paused-ready"
  ]);
  assert.deepEqual(
    sorted.map((item) => item.presentation.sortBucket),
    [0, 1, 2, 2, 2, 4, 5, 6, 7, 9]
  );
});

test("presented plans expose attachment metadata without local filesystem paths", () => {
  const presented = presentPlan(plan({
    id: "attachment-plan",
    title: "Attachment plan",
    attachments: [{
      id: "attachment-one",
      kind: "image",
      name: "preview.png",
      path: "C:\\private\\preview.png",
      size: 8,
      mimeType: "image/png",
      sha256: "a".repeat(64)
    }]
  }));

  assert.equal(presented.attachments[0]?.name, "preview.png");
  assert.equal("path" in presented.attachments[0]!, false);
});

test("unchanged plan catalogs reuse their presented ordering across page requests", () => {
  const source = [
    plan({ id: "one", title: "One" }),
    plan({ id: "two", title: "Two", status: "已完成" })
  ];

  const first = presentPlans(source);
  const second = presentPlans(source);
  const changedCatalog = presentPlans([...source]);

  assert.equal(second, first);
  assert.notEqual(changedCatalog, first);
});

test("plan pages preserve Manager ordering and expose stable counts while advancing the cursor", () => {
  const presented = presentPlans([
    plan({ id: "running", title: "Running" }),
    plan({ id: "qa", title: "QA", currentStepId: "qa", currentStep: "QA 已真实发送，sentMessageId=1003。", steps: [{ id: "qa", title: "等待 QA 验收", status: "进行中" }] }),
    plan({ id: "done", title: "Done", status: "已完成" }),
    plan({ id: "archived", title: "Archived", status: "已归档" })
  ]);

  const first = paginateRolePlans(presented, "", 2);
  const second = paginateRolePlans(presented, first.nextCursor, 2);

  assert.deepEqual(first.items.map((item) => item.id), presented.slice(0, 2).map((item) => item.id));
  assert.deepEqual(second.items.map((item) => item.id), presented.slice(2).map((item) => item.id));
  assert.equal(first.nextCursor, "2");
  assert.equal(second.nextCursor, "");
  assert.deepEqual(first.counts, {
    total: 4,
    current: 2,
    plans: 3,
    archived: 1,
    blocked: 0,
    qa: 1,
    active: 2,
    stages: {
      executing: 1,
      qa: 1,
      waitingPackage: 0,
      waitingExternal: 0,
      approval: 0,
      pending: 0,
      paused: 0,
      completed: 1,
      archived: 1
    }
  });
  assert.deepEqual(second.counts, first.counts);
});

test("plan pages filter by the requested view and full plan query before advancing the cursor", () => {
  const presented = presentPlans([
    plan({
      id: "current-target",
      title: "Current target",
      steps: [{ id: "work", title: "Work", status: "进行中", detail: "knowledge latency regression" }]
    }),
    plan({ id: "current-other", title: "Current other" }),
    plan({ id: "done-target", title: "Done target", status: "已完成", keywords: ["knowledge latency regression"] }),
    plan({ id: "archived-target", title: "Archived target", status: "已归档", keywords: ["knowledge latency regression"] })
  ]);

  const current = paginateRolePlans(presented, "", 1, {
    view: "current",
    query: "KNOWLEDGE LATENCY"
  });
  const archived = paginateRolePlans(presented, "", 8, {
    view: "archived",
    query: "knowledge latency"
  });

  assert.deepEqual(current.items.map((item) => item.id), ["current-target"]);
  assert.equal(current.total, 1);
  assert.equal(current.nextCursor, "");
  assert.equal(current.counts.total, 4);
  assert.deepEqual(archived.items.map((item) => item.id), ["archived-target"]);
  assert.equal(archived.total, 1);
});

test("plan pages apply Manager-side status filters and update-time sorting before pagination", () => {
  const presented = presentPlans([
    plan({ id: "running-old", title: "Running old", updatedAt: "2026-07-01T00:00:00.000Z", keywords: ["WebGUI"] }),
    plan({ id: "done-new", title: "Done new", status: "已完成", updatedAt: "2026-07-04T00:00:00.000Z", keywords: ["Release"] }),
    plan({ id: "running-new", title: "Running new", updatedAt: "2026-07-03T00:00:00.000Z", keywords: ["WebGUI", "Performance"] })
  ]);

  const byTime = paginateRolePlans(presented, "", 8, { view: "plans", sort: "updated" });
  const runningOnly = paginateRolePlans(presented, "", 8, {
    view: "plans",
    sort: "updated",
    statuses: ["正在执行"],
    tags: ["performance"]
  });

  assert.deepEqual(byTime.items.map((item) => item.id), ["done-new", "running-new", "running-old"]);
  assert.deepEqual(runningOnly.items.map((item) => item.id), ["running-new"]);
  assert.equal(runningOnly.total, 1);
  assert.deepEqual(byTime.facets.statuses.map((item) => [item.status, item.count]), [
    ["正在执行", 2],
    ["已完成", 1]
  ]);
  assert.deepEqual(byTime.facets.tags, [
    { tag: "WebGUI", count: 2 },
    { tag: "Performance", count: 1 },
    { tag: "Release", count: 1 }
  ]);
});

test("later plan pages can omit repeated filter facets", () => {
  const presented = presentPlans([
    plan({ id: "one", title: "One", keywords: ["WebGUI", "Performance"] }),
    plan({ id: "two", title: "Two", keywords: ["Release"] })
  ]);

  const page = paginateRolePlans(presented, "1", 1, { includeFacets: false });

  assert.equal(page.items.length, 1);
  assert.deepEqual(page.facets, { statuses: [], tags: [] });
});

test("plan pages sort importance and urgency before pagination", () => {
  const presented = presentPlans([
    plan({ id: "missing", title: "Missing priority", updatedAt: "2026-08-01T00:00:00.000Z" }),
    plan({ id: "low", title: "Low", importance: 3, urgency: 3, updatedAt: "2026-08-01T00:00:00.000Z" }),
    plan({ id: "general", title: "General", priority: "3:一般", urgency: 2, updatedAt: "2026-08-01T00:00:00.000Z" }),
    plan({ id: "high", title: "High", importance: 1, urgency: 1, updatedAt: "2026-08-01T00:00:00.000Z" }),
    plan({ id: "important", title: "Important", priority: "2:重要", updatedAt: "2026-08-01T00:00:00.000Z" }),
    plan({ id: "p0", title: "P0", importance: 0, updatedAt: "2026-08-01T00:00:00.000Z" }),
    plan({ id: "very-important", title: "Very important", priority: "1:非常重要", urgency: 0, updatedAt: "2026-08-01T00:00:00.000Z" }),
    plan({ id: "medium", title: "Medium", importance: 2, updatedAt: "2026-08-01T00:00:00.000Z" })
  ]);

  const byImportance = paginateRolePlans(presented, "", 20, { sort: "importance" });
  const byUrgency = paginateRolePlans(presented, "", 20, { sort: "urgency" });

  assert.deepEqual(byImportance.items.map((item) => item.id), [
    "p0",
    "very-important",
    "high",
    "important",
    "general",
    "medium",
    "low",
    "missing"
  ]);
  assert.deepEqual(byUrgency.items.map((item) => item.id), [
    "very-important",
    "high",
    "general",
    "low",
    "important",
    "medium",
    "missing",
    "p0"
  ]);
});

test("plan presentation exposes integer sort levels separately from labels and colors", () => {
  const presented = presentPlan(plan({
    id: "integer-levels",
    title: "Integer levels",
    status: "进行中",
    importance: 0,
    urgency: 2
  }));

  assert.equal(presented.presentation.statusLevel, 2);
  assert.equal(presented.presentation.sortBucket, 2);
  assert.equal(presented.presentation.importance.level, 0);
  assert.equal(presented.presentation.importance.label, "最高");
  assert.equal(presented.presentation.urgency.level, 2);
  assert.equal(presented.presentation.urgency.label, "中");
  assert.notEqual(
    presented.presentation.importance.palette.background,
    presented.presentation.urgency.palette.background
  );
});

test("plan page counts summarize the Manager-derived presentation stages", () => {
  const presented = presentPlans([
    plan({ id: "executing", title: "Executing" }),
    plan({ id: "qa", title: "QA", currentStepId: "qa", currentStep: "QA 已真实发送，sentMessageId=1004。", steps: [{ id: "qa", title: "QA", status: "进行中" }] }),
    plan({
      id: "package",
      title: "Package",
      currentStepId: "package",
      waitingFor: "等待目标包身份",
      steps: [
        {
          id: "implement",
          title: "Implement",
          detail: "Main→Release 已同步，Art 不适用；SVN 提交 r224818；无文本/属性/树冲突或 obstruction，svn status --show-updates 无 *。",
          status: "已完成"
        },
        { id: "package", title: "Package", status: "进行中" }
      ]
    }),
    plan({
      id: "external",
      title: "External",
      currentStepId: "collect",
      waitingFor: "等待外部负责人回传结果",
      steps: [{ id: "collect", title: "Collect", status: "进行中" }]
    }),
    plan({
      id: "approval",
      title: "Approval",
      currentStepId: "approve",
      steps: [{ id: "approve", title: "Approve", status: "进行中", approvalRequest: approvalRequest() }]
    }),
    plan({ id: "pending", title: "Pending", status: "未开始" }),
    plan({ id: "paused", title: "Paused", status: "暂停" }),
    plan({ id: "completed", title: "Completed", status: "已完成" }),
    plan({ id: "archived", title: "Archived", status: "已归档" })
  ]);

  assert.deepEqual(paginateRolePlans(presented, "", 20).counts.stages, {
    executing: 1,
    qa: 1,
    waitingPackage: 1,
    waitingExternal: 1,
    approval: 1,
    pending: 1,
    paused: 1,
    completed: 1,
    archived: 1
  });
});

test("plan page inputs reject invalid cursors and clamp oversized limits", () => {
  assert.equal(normalizeRolePlanPageLimit(null), 12);
  assert.equal(normalizeRolePlanPageLimit("0"), 1);
  assert.equal(normalizeRolePlanPageLimit("999"), 250);
  assert.throws(() => normalizeRolePlanPageLimit("many"), /Invalid plan page limit/);
  assert.throws(() => paginateRolePlans([], "next", 12), /Invalid plan page cursor/);
});

test("plan summaries keep title, type, status and ordering metadata without formal content", () => {
  const presented = presentPlan(plan({
    id: "summary",
    title: "Summary first",
    kind: "design",
    focus: "Full focus content",
    attachments: [{
      id: "image",
      kind: "image",
      name: "large.png",
      path: "C:\\private\\large.png",
      size: 1024,
      mimeType: "image/png",
      sha256: "a".repeat(64)
    }],
    steps: [{ id: "implementation", title: "Formal step content", status: "进行中" }]
  }));
  const summary = summarizeRolePlan(presented);

  assert.equal(summary.title, "Summary first");
  assert.equal(summary.kind, "design");
  assert.equal(summary.presentation.status, presented.presentation.status);
  assert.equal(summary.attachmentCount, 1);
  assert.equal(summary.stepCount, 1);
  assert.equal("focus" in summary, false);
  assert.equal("attachments" in summary, false);
  assert.equal("steps" in summary, false);
  assert.equal("contract" in summary.presentation.approval, false);
});

test("memory lists are sorted by updatedAt without mutating the source array", () => {
  const items: RecentMemoryItem[] = [
    {
      id: "older",
      title: "Older",
      focus: "Older",
      content: "Older",
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
      keywords: []
    },
    {
      id: "newer",
      title: "Newer",
      focus: "Newer",
      content: "Newer",
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-23T00:00:00.000Z",
      keywords: []
    }
  ];

  assert.deepEqual(sortKnowledgeByUpdatedAt(items).map((item) => item.id), ["newer", "older"]);
  assert.deepEqual(items.map((item) => item.id), ["older", "newer"]);
});

test("memory pages filter full memory content and return bounded cursors with stable category counts", () => {
  const items: RecentMemoryItem[] = [
    {
      id: "newer",
      title: "Newer",
      focus: "Newer",
      content: "knowledge performance target",
      createdAt: "2026-07-02T00:00:00.000Z",
      updatedAt: "2026-07-02T00:00:00.000Z",
      keywords: []
    },
    {
      id: "older",
      title: "Older",
      focus: "Older",
      content: "unrelated",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      keywords: []
    }
  ];

  const page = paginateRoleMemory(items, "", 1, "PERFORMANCE TARGET", {
    recent: 2,
    consolidated: 3,
    archived: 4,
    consolidationRuns: 1
  });

  assert.deepEqual(page.items.map((item) => item.id), ["newer"]);
  assert.equal(page.total, 1);
  assert.equal(page.nextCursor, "");
  assert.deepEqual(page.counts, { recent: 2, consolidated: 3, archived: 4, consolidationRuns: 1 });
  assert.equal(normalizeRoleMemoryPageLimit(null), 24);
  assert.equal(normalizeRoleMemoryPageLimit("999"), 100);
});
