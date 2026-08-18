import assert from "node:assert/strict";
import test from "node:test";
import type { PlanItem } from "./roleKnowledge.js";
import {
  migrateLegacyPackageGatePlan,
  planHasTargetPackageInclusionEvidence,
  planIsStructuredQaPhase,
  planIsWaitingForPackage,
  planIsWaitingForQaAcceptance
} from "./planPackageWaiting.js";

function plan(patch: Partial<PlanItem>): PlanItem {
  return {
    id: "package-plan",
    title: "Package plan",
    focus: "Package plan",
    status: "进行中",
    currentStepId: "package",
    attachments: [],
    steps: [
      { id: "implement", title: "完成实现", status: "已完成" },
      {
        id: "matching-tests",
        title: "完成匹配测试与同步提交",
        detail: "匹配测试 1/1 通过；Main→Release 已同步，Art 不适用；SVN 提交 r224818；无文本/属性/树冲突或 obstruction，svn status --show-updates 无 *。",
        status: "已完成"
      },
      { id: "package", title: "等待打包", status: "进行中" }
    ],
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
    keywords: [],
    ...patch
  };
}

test("package waiting uses the structured package step and excludes QA, approval, material, and unfinished work", () => {
  assert.equal(planIsWaitingForPackage(plan({ waitingFor: "等待合包并返回目标包身份" })), true);
  assert.equal(planIsWaitingForPackage(plan({ waitingFor: "等待构建完成并返回包产物" })), true);
  assert.equal(planIsWaitingForPackage(plan({ waitingFor: "等待确认 r224818 已进包" })), true);

  assert.equal(planIsWaitingForPackage(plan({
    steps: [
      { id: "implement", title: "完成 Main 实现", status: "已完成" },
      { id: "matching-tests", title: "完成测试", status: "已完成" },
      { id: "package", title: "等待目标包", status: "进行中" }
    ],
    waitingFor: "等待目标包身份与进包结果"
  })), false);

  assert.equal(planIsWaitingForPackage(plan({
    currentStepId: "package-next-client-build",
    waitingFor: "等待用户今晚明确说‘开始打包’",
    steps: [
      { id: "scope-audit", title: "核对范围", status: "已完成" },
      { id: "reverify", title: "回读上一目标包", status: "已完成" },
      { id: "package-next-client-build", title: "等待下一次打包", status: "进行中" },
      { id: "close", title: "收口", status: "未开始" }
    ]
  })), false);

  assert.equal(planIsWaitingForPackage(plan({
    currentStepId: "verify-package",
    waitingFor: "等待目标包后由 QA 验收",
    steps: [
      { id: "implement", title: "完成实现", status: "已完成" },
      { id: "verify-package", title: "QA 验收目标包", status: "进行中" }
    ]
  })), false);
  assert.equal(planIsWaitingForPackage(plan({ waitingFor: "等待用户批准打包方案" })), false);
  assert.equal(planIsWaitingForPackage(plan({ waitingFor: "等待补充打包说明资料" })), false);
  assert.equal(planIsWaitingForPackage(plan({
    currentStepId: "implement",
    waitingFor: "等待正式打包任务恢复现场",
    steps: [
      { id: "implement", title: "继续实现", status: "进行中" },
      { id: "matching-tests", title: "完成匹配测试", status: "未开始" },
      { id: "package", title: "等待目标包", status: "未开始" }
    ]
  })), false);
});

test("PangHu package lifecycle stays running until formal sync, submit, and conflict-free readback are complete", () => {
  const incomplete = plan({
    waitingFor: "等待目标包身份",
    steps: [
      { id: "implement", title: "完成 Main 实现", detail: "Main 已完成开发验证。", status: "已完成" },
      { id: "package", title: "等待目标包", status: "进行中" }
    ]
  });
  assert.equal(planIsWaitingForPackage(incomplete), false);
  assert.equal(planIsWaitingForPackage(plan({ waitingFor: "等待目标包身份与进包结果" })), true);

  const realPlanShape = plan({
    waitingFor: "等待本轮目标包构建完成；需回读版本、渠道、构建编号和Release r225253纳入证明。",
    steps: [
      { id: "implement", title: "完成实现", status: "已完成" },
      { id: "development-validation-release", title: "完成Release验证与提交", detail: "Release matching test 1/1 passed。", status: "已完成" },
      {
        id: "package",
        title: "等待目标包并证明纳入 Release r225253",
        detail: "等待打包前置门槛已完成：Main测试变更r225252、Release六路径与测试r225253已提交；本计划无Art侧目标；无文本/属性/树冲突或 obstruction，svn status --show-updates 无 *。",
        status: "进行中"
      }
    ]
  });
  assert.equal(planIsWaitingForPackage(realPlanShape), true);
});

test("a completed delivery remains waiting for a target package when a prior package step was closed by a failed reconcile", () => {
  const reconciled = plan({
    currentStepId: "program-verify-freeze-evidence",
    currentStep: "补齐冻结包前交付合同的机器可识别字段。",
    nextAction: "原任务补齐严格审计可识别字段；满足门槛后再等待目标包。",
    steps: [
      { id: "implement", title: "完成实现", status: "已完成" },
      {
        id: "delivery-closure",
        title: "完成 Main/Release 同步、SVN 提交与无冲突回读",
        detail: "Main r225142；Release r225143；Art 不适用。精确 changed paths 已回读；EditMode 6/6 通过；无文本/属性/树冲突或 obstruction，svn status --show-updates 无 *。",
        status: "已完成"
      },
      {
        id: "package-onparser-target",
        title: "等待目标包纳入",
        detail: "目标包需提供版本、渠道、构建编号和包含 Release r225143 的纳入证明。",
        status: "未开始"
      },
      { id: "program-verify-freeze-evidence", title: "补齐冻结包前交付合同", status: "进行中" }
    ]
  });

  assert.equal(planIsWaitingForPackage(reconciled), true);
});

test("a current package step ignores a stale QA step once the delivery closure is complete", () => {
  const accountIsolation = plan({
    currentStepId: "package-account-save-identity-target",
    currentStep: "等待账号隔离目标包纳入。",
    nextAction: "记录目标包版本、渠道、构建编号及包含 Release r226352 的纳入证明。",
    waitingFor: "目标包版本、渠道、构建编号及包含 Release r226352 的构建输入或 manifest 纳入证明。",
    steps: [
      { id: "implement-test", title: "实施账号归属保护并完成非Unity回归", detail: "Main与Release目标筛选均 matched=8、passed=8、failed=0。", status: "已完成" },
      {
        id: "svn-release-package",
        title: "完成Main/Release同步提交与无冲突回读",
        detail: "Main r226349；Release r226352；Art不适用。精确十文件范围无本地diff、无文本/属性/树冲突或obstruction；svn status --show-updates 无 *。",
        status: "已完成"
      },
      { id: "qa-acceptance", title: "目标包交付QA并等待双账号验收", status: "未开始" },
      { id: "package-account-save-identity-target", title: "等待账号隔离目标包纳入", status: "进行中" }
    ]
  });

  assert.equal(planIsWaitingForPackage(accountIsolation), true);
});

test("package waiting requires the complete machine-readable conflict readback contract", () => {
  const ambiguous = plan({
    waitingFor: "等待目标包身份",
    steps: [
      { id: "implement", title: "完成 Main 实现", status: "已完成" },
      {
        id: "matching-tests",
        title: "完成同步提交",
        detail: "Main→Release 已同步，Art 不适用；SVN 提交 r225253；无目标 diff 或远端更新。",
        status: "已完成"
      },
      { id: "package", title: "等待目标包", status: "进行中" }
    ]
  });
  assert.equal(planIsWaitingForPackage(ambiguous), false);

  const complete = plan({
    waitingFor: "等待目标包身份",
    steps: ambiguous.steps.map((step) => step.id === "matching-tests"
      ? {
          ...step,
          detail: "匹配测试 1/1 通过；Main→Release 已同步，Art 不适用；SVN 提交 r225253；无文本/属性/树冲突或 obstruction，svn status --show-updates 无 *。"
        }
      : step)
  });
  assert.equal(planIsWaitingForPackage(complete), true);
});

test("package waiting keeps a missing matching-test result in progress even when sync and readback are complete", () => {
  const noTestResult = plan({
    waitingFor: "等待目标包身份",
    steps: [
      { id: "implement", title: "完成实现", status: "已完成" },
      {
        id: "delivery-closure",
        title: "完成 Main/Release 同步、SVN 提交与无冲突回读",
        detail: "Main r225142；Release r225143；Art 不适用。精确 changed paths 已回读；无文本/属性/树冲突或 obstruction，svn status --show-updates 无 *。",
        status: "已完成"
      },
      { id: "package", title: "等待目标包", status: "进行中" }
    ]
  });

  assert.equal(planIsWaitingForPackage(noTestResult), false);
});

test("package waiting accepts an EditMode passed/failed result recorded with a run identifier", () => {
  const editModeResult = plan({
    waitingFor: "等待目标包身份",
    steps: [
      { id: "implement", title: "完成实现", status: "已完成" },
      {
        id: "validate-main-release",
        title: "完成Main/Release匹配测试与Unity编译检查",
        detail: "Main EditMode runId=display-main：1 passed/0 failed；Release EditMode：1 passed/0 failed。",
        status: "已完成"
      },
      {
        id: "sync-submit-readback",
        title: "完成Main/Release同步、SVN提交与无冲突回读",
        detail: "Main r225928、Release r225929；Art不适用；精确四路径已回读；无文本/属性/树冲突或obstruction，svn status --show-updates 无 *。",
        status: "已完成"
      },
      { id: "package", title: "等待目标包", status: "进行中" }
    ]
  });

  assert.equal(planIsWaitingForPackage(editModeResult), true);
});

test("non-Unity logic and deferred UI runtime acceptance do not block package waiting after delivery closure", () => {
  const nonUi = plan({
    waitingFor: "等待目标包身份与纳入证明",
    steps: [
      {
        id: "implement",
        title: "完成纯 C# 数据转换规则",
        detail: "非 Unity 测试 matched=6, failed=0。",
        status: "已完成"
      },
      {
        id: "delivery-closure",
        title: "完成同步提交回读",
        detail: "Main→Release 已同步，Art 不适用；SVN 提交 r225300；无文本/属性/树冲突或 obstruction，svn status --show-updates 无 *。",
        status: "已完成"
      },
      { id: "package", title: "等待目标包", status: "进行中" }
    ]
  });
  assert.equal(planIsWaitingForPackage(nonUi), true);

  const uiWithDeferredRuntime = plan({
    ...nonUi,
    steps: nonUi.steps.map((step) => step.id === "implement"
      ? {
          ...step,
          title: "完成 UI 静态与序列化合同",
          detail: "静态引用与序列化检查通过；GameView、PlayMode 交互和 Unity 生命周期列入不干扰用户 Editor 的包内 QA 合同。"
        }
      : step)
  });
  assert.equal(planIsWaitingForPackage(uiWithDeferredRuntime), true);
});

test("target package inclusion moves the structured QA phase from package waiting to QA acceptance", () => {
  const qaWithoutPackageProof = plan({
    currentStepId: "send-special-qa",
    currentStep: "发送专项 QA 请求。",
    nextAction: "发送 QA 并取得 sentMessageId。",
    waitingFor: "",
    steps: [
      { id: "implement", title: "完成实现", status: "已完成" },
      {
        id: "matching-tests",
        title: "完成同步提交",
        detail: "匹配测试 1/1 通过；Main→Release 已同步，Art 不适用；SVN 提交 r225253；无文本/属性/树冲突或 obstruction，svn status --show-updates 无 *。",
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
  assert.equal(planIsStructuredQaPhase(qaWithoutPackageProof), true);
  assert.equal(planHasTargetPackageInclusionEvidence(qaWithoutPackageProof), false);
  assert.equal(planIsWaitingForPackage(qaWithoutPackageProof), true);
  assert.equal(planIsWaitingForQaAcceptance(qaWithoutPackageProof), false);

  const qaWithPackageProof = plan({
    ...qaWithoutPackageProof,
    steps: qaWithoutPackageProof.steps.map((step) => step.id === "package-target-build"
      ? {
          ...step,
          title: "完成目标统一包",
          detail: "Android/PC 1.0.298 统一包已交付，并证明纳入 Release r225253。"
        }
      : step)
  });
  assert.equal(planHasTargetPackageInclusionEvidence(qaWithPackageProof), true);
  assert.equal(planIsWaitingForPackage(qaWithPackageProof), false);
  assert.equal(planIsWaitingForQaAcceptance(qaWithPackageProof), true);
});

test("mixed package-and-QA step ids are not accepted as a structured QA phase", () => {
  const mixed = plan({
    currentStepId: "package-and-qa",
    waitingFor: "等待 QA 结论",
    steps: [
      ...plan({}).steps.slice(0, 2),
      { id: "package-and-qa", title: "打包并等待 QA", status: "进行中" }
    ]
  });
  assert.equal(planIsStructuredQaPhase(mixed), false);
  assert.equal(planIsWaitingForQaAcceptance(mixed), false);
});

test("legacy global packaging blockers migrate to non-blocked package waiting only after prior steps complete", () => {
  const source = plan({
    isBlocked: true,
    blockedBy: "等待正式打包任务恢复 Main/Release/Art 现场；当前禁止任何 Unity、SVN、测试、构建、上传、发布或 QA 推进。",
    waitingFor: "等待正式打包任务返回含 r224818 与目标包身份。",
    steps: [
      { id: "implement", title: "完成 Main / Release 实现", status: "已完成" },
      {
        id: "matching-tests",
        title: "完成双分支目标测试 3/3",
        detail: "Main→Release 已同步，Art 不适用；SVN 提交 r224818；无文本/属性/树冲突或 obstruction，svn status --show-updates 无 *。",
        status: "已完成"
      },
      {
        id: "package",
        title: "等待目标包产物",
        status: "进行中",
        waitingFor: "等待目标包身份与进包结果",
        isBlocked: true,
        blockedBy: "等待正式打包任务恢复现场"
      }
    ]
  });

  const migrated = migrateLegacyPackageGatePlan(source, "2026-07-28T10:00:00.000Z");
  assert.equal(migrated?.action, "waiting_package");
  assert.equal(migrated?.plan.isBlocked, false);
  assert.equal(migrated?.plan.blockedBy, "");
  assert.equal(migrated?.plan.steps[2]?.isBlocked, false);
  assert.equal(migrated?.plan.steps[2]?.blockedBy, "");
  assert.equal(migrated?.plan.waitingFor, source.waitingFor);
  assert.equal(planIsWaitingForPackage(migrated!.plan), true);
});

test("legacy packaging gates resume unfinished work without changing its business task binding", () => {
  const taskBinding: PlanItem["taskBinding"] = {
    agentType: "codex",
    sessionId: "019fa319-25c6-78a0-9364-b0a4ffe8dc4c",
    sessionTitle: "Original business task",
    workspace: "C:/Projects/Example"
  };
  const source = plan({
    currentStepId: "implement",
    currentStep: "继续实现并完成匹配测试",
    waitingFor: "等待正式打包任务恢复现场",
    isBlocked: true,
    blockedBy: "等待正式打包任务恢复 Main/Release/Art 现场；当前禁止任何 Unity、SVN、测试、构建、上传、发布或 QA 推进。",
    taskBinding,
    steps: [
      {
        id: "implement",
        title: "继续实现",
        status: "进行中",
        waitingFor: "等待正式打包任务恢复现场",
        isBlocked: true,
        blockedBy: "等待正式打包任务恢复现场"
      },
      { id: "matching-tests", title: "完成匹配测试", status: "未开始" },
      { id: "package", title: "等待目标包", status: "未开始" }
    ]
  });

  const migrated = migrateLegacyPackageGatePlan(source, "2026-07-28T10:00:00.000Z");
  assert.equal(migrated?.action, "resume_running");
  assert.equal(migrated?.plan.status, "进行中");
  assert.equal(migrated?.plan.isBlocked, false);
  assert.equal(migrated?.plan.blockedBy, "");
  assert.equal(migrated?.plan.waitingFor, "");
  assert.equal(migrated?.plan.steps[0]?.waitingFor, "");
  assert.deepEqual(migrated?.plan.taskBinding, taskBinding);
  assert.equal(planIsWaitingForPackage(migrated!.plan), false);
});
