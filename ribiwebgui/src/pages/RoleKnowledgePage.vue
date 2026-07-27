<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useI18n } from "../i18n";
import { loadPlanFeedback, loadRoleKnowledge, submitPlanFeedback } from "../roleKnowledgeClient";
import { planCardStyle, planStatusStyle, plansForKnowledgeView } from "../planPresentationStyles";
import type { PlanKnowledgeView } from "../planPresentationStyles";
import { useGatewayStore } from "../stores/gatewayStore";
import type { RoleMemory, RolePlan, RolePlanFeedback, RolePlanStep } from "../types";

const store = useGatewayStore();
const { isEnglish, t } = useI18n();
const plans = ref<RolePlan[]>([]);
const recentMemory = ref<RoleMemory[]>([]);
const consolidatedMemory = ref<RoleMemory[]>([]);
const loading = ref(false);
const error = ref("");
const activeView = ref<PlanKnowledgeView>("current");
const query = ref("");
const expandedPlans = reactive<Record<string, boolean>>({});
const approvalDrafts = reactive<Record<string, string>>({});
const approvalPending = reactive<Record<string, boolean>>({});
const approvalRequestIds = reactive<Record<string, string>>({});
const approvalNotices = reactive<Record<string, { tone: "success" | "warning" | "error"; text: string }>>({});
const submittedApprovalTexts = new Map<string, string>();
let requestVersion = 0;
let managerEvents: EventSource | null = null;

const roleId = computed(() => String(store.selectedGateway?.agentRoleId || "").trim());
const gatewayId = computed(() => String(store.selectedGateway?.id || "").trim());
const roleLabel = computed(() => roleId.value || t("未绑定人格"));
const dateFormatter = computed(() => new Intl.DateTimeFormat(isEnglish.value ? "en" : "zh-CN", {
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit"
}));

const planCounts = computed(() => ({
  blocked: plans.value.filter((plan) => plan.presentation.tone === "blocked").length,
  qa: plans.value.filter((plan) => plan.presentation.tone === "qa").length,
  active: plans.value.filter((plan) => !["paused", "done", "archived"].includes(plan.presentation.tone)).length
}));

function matchesQuery(item: RolePlan | RoleMemory): boolean {
  const normalized = query.value.trim().toLowerCase();
  if (!normalized) return true;
  return [item.id, item.title, item.focus, ...item.keywords]
    .some((value) => String(value || "").toLowerCase().includes(normalized));
}

const activePlans = computed(() => plansForKnowledgeView(plans.value, "plans"));
const currentPlans = computed(() => plansForKnowledgeView(plans.value, "current"));
const archivedPlans = computed(() => plansForKnowledgeView(plans.value, "archived"));
const visiblePlansForView = computed(() => {
  const source = activeView.value === "current"
    ? currentPlans.value
    : activeView.value === "plans"
      ? activePlans.value
      : activeView.value === "archived"
        ? archivedPlans.value
        : [];
  return source.filter(matchesQuery);
});
const visibleRecentMemory = computed(() => recentMemory.value.filter(matchesQuery));
const visibleConsolidatedMemory = computed(() => consolidatedMemory.value.filter(matchesQuery));
const visibleMemoryForView = computed(() => activeView.value === "archived"
  ? visibleConsolidatedMemory.value
  : visibleRecentMemory.value);
const showsPlanList = computed(() => ["current", "plans", "archived"].includes(activeView.value));
const showsMemoryList = computed(() => ["current", "recent_memory", "archived"].includes(activeView.value));

async function refreshKnowledge(): Promise<void> {
  const selectedRoleId = roleId.value;
  if (!selectedRoleId) {
    plans.value = [];
    recentMemory.value = [];
    consolidatedMemory.value = [];
    error.value = "";
    return;
  }
  const currentRequest = ++requestVersion;
  loading.value = true;
  error.value = "";
  try {
    const result = await loadRoleKnowledge(selectedRoleId);
    if (currentRequest !== requestVersion) return;
    plans.value = result.plans;
    recentMemory.value = result.memory.recent;
    consolidatedMemory.value = result.memory.consolidated;
  } catch (loadError) {
    if (currentRequest !== requestVersion) return;
    error.value = loadError instanceof Error ? loadError.message : String(loadError);
  } finally {
    if (currentRequest === requestVersion) loading.value = false;
  }
}

watch(
  [roleId, () => store.loading],
  (current, previous) => {
    const [nextRoleId, managerLoading] = current;
    const previousRoleId = previous?.[0];
    const previousManagerLoading = previous?.[1];
    if (!nextRoleId || managerLoading) return;
    if (!previous || nextRoleId !== previousRoleId || previousManagerLoading === true) void refreshKnowledge();
  },
  { immediate: true }
);

function stepColor(plan: RolePlan, step: RolePlanStep): string {
  if (plan.presentation.tone !== "paused" && step.blockedBy) return "error";
  if (step.status === "已完成") return "success";
  if (step.status === "进行中") return "primary";
  return "grey";
}

function currentStep(plan: RolePlan): RolePlanStep | undefined {
  return plan.steps.find((step) => step.id === plan.currentStepId)
    || plan.steps.find((step) => step.status === "进行中");
}

function blocker(plan: RolePlan): string {
  if (plan.presentation.tone === "paused") return "";
  return currentStep(plan)?.blockedBy || plan.blockedBy || "";
}

function completedSteps(plan: RolePlan): number {
  return plan.steps.filter((step) => step.status === "已完成").length;
}

function progressValue(plan: RolePlan): number {
  return plan.steps.length ? Math.round(completedSteps(plan) * 100 / plan.steps.length) : 0;
}

function formatDate(value: string | undefined): string {
  if (!value) return t("未记录");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return dateFormatter.value.format(date);
}

function togglePlan(planId: string): void {
  expandedPlans[planId] = !expandedPlans[planId];
}

function approvalMissingLabel(field: string): string {
  const labels: Record<string, string> = {
    request: "批准事项",
    reason: "审批原因",
    affectedActions: "文件、命令或外部变更",
    validation: "验证方式",
    rollback: "回退方案",
    outOfScope: "明确不在范围内的内容"
  };
  return t(labels[field] || field);
}

function approvalFileAction(action: string): string {
  return t({ create: "新建", modify: "修改", delete: "删除", move: "移动" }[action] || action);
}

function feedbackRequestId(planId: string): string {
  const existing = approvalRequestIds[planId];
  if (existing) return existing;
  const generated = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  approvalRequestIds[planId] = generated;
  return generated;
}

function applyPlanApproval(planId: string, approval: RolePlan["approval"]): void {
  const index = plans.value.findIndex((plan) => plan.id === planId);
  if (index < 0) return;
  const plan = plans.value[index];
  plans.value[index] = { ...plan, approval };
}

function applyFeedbackDeliveryState(planId: string, feedback: RolePlanFeedback | undefined): void {
  const requestId = approvalRequestIds[planId];
  if (!feedback || !requestId || feedback.id !== requestId) return;
  if (feedback.deliveryStatus === "delivered" || feedback.deliveryStatus === "record_only") {
    approvalNotices[planId] = { tone: "success", text: t("审批建议已记录并交给 Agent 处理。") };
    approvalRequestIds[planId] = "";
    submittedApprovalTexts.delete(planId);
    return;
  }
  if (feedback.deliveryStatus === "failed") {
    const submittedText = submittedApprovalTexts.get(planId);
    if (submittedText && !approvalDrafts[planId]) approvalDrafts[planId] = submittedText;
    approvalNotices[planId] = {
      tone: "warning",
      text: t("审批建议已记录，但通知 Agent 失败；可以保留内容后重试。")
    };
  }
}

async function refreshPlanApproval(planId: string): Promise<void> {
  const selectedRoleId = roleId.value;
  if (!selectedRoleId || !plans.value.some((plan) => plan.id === planId)) return;
  try {
    const approval = await loadPlanFeedback(selectedRoleId, planId);
    if (selectedRoleId !== roleId.value) return;
    applyPlanApproval(planId, approval);
    applyFeedbackDeliveryState(planId, approval.latest);
  } catch {
    // The submission result remains visible; a later Manager event or manual refresh can reconcile it.
  }
}

onMounted(() => {
  managerEvents = new EventSource("/api/events");
  managerEvents.addEventListener("plan_feedback_changed", (raw) => {
    try {
      const data = JSON.parse((raw as MessageEvent).data || "{}") as { roleId?: string; planId?: string };
      if (data.roleId === roleId.value && data.planId) void refreshPlanApproval(data.planId);
    } catch {
      // Ignore malformed event payloads and keep the latest valid plan snapshot.
    }
  });
});

onBeforeUnmount(() => managerEvents?.close());

async function sendApprovalSuggestion(plan: RolePlan): Promise<void> {
  const text = String(approvalDrafts[plan.id] || "").trim();
  if (!text) {
    approvalNotices[plan.id] = { tone: "error", text: t("请先填写审批建议。") };
    return;
  }
  if (!gatewayId.value) {
    approvalNotices[plan.id] = { tone: "error", text: t("当前没有可投递的 Route。") };
    return;
  }
  approvalPending[plan.id] = true;
  delete approvalNotices[plan.id];
  try {
    const result = await submitPlanFeedback({
      roleId: roleId.value,
      planId: plan.id,
      gatewayId: gatewayId.value,
      stepId: plan.presentation.approval.stepId,
      feedbackId: feedbackRequestId(plan.id),
      text,
      source: "webgui"
    });
    const isExistingLatest = plan.approval.latest?.id === result.id;
    applyPlanApproval(plan.id, {
      count: plan.approval.count + (isExistingLatest ? 0 : 1),
      latest: result
    });
    if (result.deliveryStatus === "failed") {
      approvalNotices[plan.id] = {
        tone: "warning",
        text: t("审批建议已记录，但通知 Agent 失败；可以保留内容后重试。")
      };
    } else if (result.deliveryStatus === "pending") {
      submittedApprovalTexts.set(plan.id, text);
      approvalDrafts[plan.id] = "";
      approvalNotices[plan.id] = { tone: "success", text: t("审批建议已记录，正在后台通知 Agent。") };
    } else {
      approvalDrafts[plan.id] = "";
      approvalRequestIds[plan.id] = "";
      submittedApprovalTexts.delete(plan.id);
      approvalNotices[plan.id] = { tone: "success", text: t("审批建议已记录并交给 Agent 处理。") };
    }
  } catch (submitError) {
    approvalNotices[plan.id] = {
      tone: "error",
      text: submitError instanceof Error ? submitError.message : String(submitError)
    };
  } finally {
    approvalPending[plan.id] = false;
  }
}
</script>

<template>
  <div class="page-shell knowledge-page">
    <section class="knowledge-hero app-card">
      <div class="knowledge-hero-copy">
        <div class="eyebrow">ROLE KNOWLEDGE LEDGER</div>
        <h1>计划与记忆</h1>
        <p>计划主体与记忆由 Agent 维护；数据、显示状态、排序和审批说明均来自 Rabi Manager。说明不完整时会提醒 Agent 补充，但不会限制用户提交审批意见。</p>
      </div>
      <div class="knowledge-identity">
        <span>当前人格</span>
        <strong data-no-i18n>{{ roleLabel }}</strong>
        <small>{{ t("待审批优先，再按状态与更新时间排序") }}</small>
      </div>
    </section>

    <div class="knowledge-metrics">
      <div class="knowledge-metric blocked"><span>阻塞中</span><b>{{ planCounts.blocked }}</b><small>需要先解除依赖</small></div>
      <div class="knowledge-metric qa"><span>待QA测试</span><b>{{ planCounts.qa }}</b><small>等待验证或验收</small></div>
      <div class="knowledge-metric active"><span>活跃计划</span><b>{{ planCounts.active }}</b><small>当前仍在推进</small></div>
      <div class="knowledge-metric memory"><span>可读记忆</span><b>{{ recentMemory.length + consolidatedMemory.length }}</b><small>近期与沉淀合计</small></div>
    </div>

    <v-card class="app-card knowledge-browser" variant="flat">
      <div class="knowledge-toolbar">
        <v-btn-toggle v-model="activeView" mandatory color="primary" density="comfortable" class="knowledge-tabs">
          <v-btn value="current" prepend-icon="mdi-clock-fast"><span>{{ isEnglish ? "Current" : "当前" }}</span><b>{{ currentPlans.length }}</b></v-btn>
          <v-btn value="plans" prepend-icon="mdi-clipboard-text-clock-outline"><span>{{ isEnglish ? "Plans" : "计划" }}</span><b>{{ activePlans.length }}</b></v-btn>
          <v-btn value="recent_memory" prepend-icon="mdi-memory"><span>{{ t("近期记忆") }}</span><b>{{ recentMemory.length }}</b></v-btn>
          <v-btn value="archived" prepend-icon="mdi-archive-outline"><span>{{ isEnglish ? "Archived" : "已归档" }}</span><b>{{ archivedPlans.length + consolidatedMemory.length }}</b></v-btn>
        </v-btn-toggle>
        <div class="knowledge-tools">
          <v-text-field
            v-model="query"
            label="搜索标题、主题或关键词"
            prepend-inner-icon="mdi-magnify"
            clearable
            hide-details
            density="compact"
          />
          <v-btn prepend-icon="mdi-refresh" variant="tonal" color="primary" :loading="loading" @click="refreshKnowledge">刷新</v-btn>
        </div>
      </div>

      <v-progress-linear v-if="loading" indeterminate color="secondary" />
      <v-alert v-if="error" type="error" variant="tonal" class="ma-5">{{ error }}</v-alert>
      <v-alert v-else-if="!roleId" type="warning" variant="tonal" class="ma-5">当前 Route 尚未绑定人格。</v-alert>

      <div v-if="roleId && showsPlanList" class="knowledge-list">
        <div v-if="activeView === 'current' || activeView === 'archived'" class="knowledge-subsection-heading">
          <v-icon size="20">{{ activeView === "current" ? "mdi-clipboard-play-outline" : "mdi-archive-outline" }}</v-icon>
          <b>{{ activeView === "current" ? (isEnglish ? "In-progress plans" : "进行中计划") : (isEnglish ? "Archived plans" : "已归档计划") }}</b>
        </div>
        <article v-for="plan in visiblePlansForView" :key="plan.id" class="knowledge-plan-card" :data-tone="plan.presentation.tone" :style="planCardStyle(plan.presentation.palette)">
          <div class="knowledge-plan-accent" />
          <div class="knowledge-plan-main">
            <div class="knowledge-plan-head">
              <div>
                <div class="knowledge-kicker" data-no-i18n>{{ plan.project?.name || plan.kind || "PLAN" }}</div>
                <h2 data-no-i18n>{{ plan.title }}</h2>
              </div>
              <v-chip :style="planStatusStyle(plan.presentation.palette)" variant="flat" size="small">{{ plan.presentation.status }}</v-chip>
            </div>

            <div class="knowledge-plan-summary">
              <div>
                <span>{{ blocker(plan) ? "当前阻塞" : "当前步骤" }}</span>
                <b v-if="currentStep(plan)?.title || plan.currentStep" data-no-i18n>{{ currentStep(plan)?.title || plan.currentStep }}</b>
                <b v-else>暂无进行中的步骤</b>
              </div>
              <div>
                <span>更新时间</span>
                <b data-no-i18n>{{ formatDate(plan.updatedAt) }}</b>
              </div>
              <div v-if="plan.dueAt">
                <span>截止时间</span>
                <b data-no-i18n>{{ formatDate(plan.dueAt) }}</b>
              </div>
            </div>

            <v-alert v-if="blocker(plan)" data-no-i18n type="error" variant="tonal" density="compact" class="knowledge-blocker">
              {{ blocker(plan) }}
            </v-alert>

            <div v-if="plan.steps.length" class="knowledge-progress-row">
              <v-progress-linear :model-value="progressValue(plan)" color="secondary" height="7" rounded />
              <span>{{ completedSteps(plan) }}/{{ plan.steps.length }}</span>
            </div>

            <div v-if="plan.keywords.length" class="knowledge-keywords">
              <v-chip v-for="keyword in plan.keywords" :key="keyword" data-no-i18n size="x-small" variant="outlined">{{ keyword }}</v-chip>
            </div>

            <button
              v-if="plan.steps.length || plan.presentation.approval.state !== 'none'"
              class="knowledge-expand"
              type="button"
              :aria-expanded="Boolean(expandedPlans[plan.id])"
              @click="togglePlan(plan.id)"
            >
              <span>{{ expandedPlans[plan.id] ? "收起计划详情" : plan.presentation.approval.state === "ready" ? "查看执行合同并审批" : plan.presentation.approval.state === "incomplete" ? "查看缺失的审批信息" : `查看全部 ${plan.steps.length} 个步骤` }}</span>
              <v-icon size="18">{{ expandedPlans[plan.id] ? "mdi-chevron-up" : "mdi-chevron-down" }}</v-icon>
            </button>

            <div v-if="expandedPlans[plan.id]" class="knowledge-plan-details">
                <div v-if="plan.steps.length" class="knowledge-steps">
                  <div v-for="(step, index) in plan.steps" :key="step.id" class="knowledge-step" :class="{ current: step.id === plan.currentStepId }">
                    <div class="knowledge-step-index">{{ index + 1 }}</div>
                    <div>
                      <b data-no-i18n>{{ step.title }}</b>
                      <p v-if="step.detail" data-no-i18n>{{ step.detail }}</p>
                      <small v-if="step.waitingFor" data-no-i18n>等待：{{ step.waitingFor }}</small>
                      <small v-if="plan.presentation.tone !== 'paused' && step.blockedBy" data-no-i18n>{{ step.blockedBy }}</small>
                    </div>
                    <v-chip :color="stepColor(plan, step)" size="x-small" variant="tonal">{{ plan.presentation.tone !== "paused" && step.blockedBy ? "已阻塞" : step.status }}</v-chip>
                  </div>
                </div>

                <section v-if="plan.presentation.approval.state !== 'none'" class="knowledge-approval-panel" :data-state="plan.presentation.approval.state">
                  <div class="knowledge-approval-head">
                    <div>
                      <span>{{ plan.presentation.approval.label }}</span>
                      <b v-if="currentStep(plan)" data-no-i18n>{{ currentStep(plan)?.title }}</b>
                      <p v-if="currentStep(plan)?.detail" class="knowledge-approval-plan-detail" data-no-i18n>{{ currentStep(plan)?.detail }}</p>
                    </div>
                    <v-chip :color="plan.presentation.approval.state === 'ready' ? 'primary' : 'warning'" size="x-small" variant="tonal">
                      {{ plan.presentation.approval.state === "ready" ? "可审批" : "可审批 · 待补充" }}
                    </v-chip>
                  </div>
                  <p>{{ plan.presentation.approval.helper }}</p>
                  <v-alert
                    v-if="plan.presentation.approval.missing.length"
                    type="warning"
                    variant="tonal"
                    density="compact"
                    class="knowledge-approval-missing"
                  >
                    <b>建议 Agent 补充：</b>
                    <span>{{ plan.presentation.approval.missing.map(approvalMissingLabel).join("、") }}</span>
                  </v-alert>
                  <div v-if="plan.presentation.approval.contract" class="knowledge-approval-contract">
                    <div class="knowledge-approval-contract-lead">
                      <span>申请批准</span>
                      <b data-no-i18n>{{ plan.presentation.approval.contract.request || "未填写" }}</b>
                      <small data-no-i18n>{{ plan.presentation.approval.contract.reason || "未填写审批原因" }}</small>
                    </div>
                    <section v-if="plan.presentation.approval.contract.files.length" class="knowledge-approval-contract-section">
                      <h4>文件改动</h4>
                      <div v-for="(item, index) in plan.presentation.approval.contract.files" :key="`file-${index}`" class="knowledge-approval-contract-item">
                        <div><v-chip size="x-small" variant="tonal">{{ approvalFileAction(item.action) }}</v-chip><code data-no-i18n>{{ item.path }}</code></div>
                        <p data-no-i18n>{{ item.change }}</p>
                        <small v-if="item.destination" data-no-i18n>目标：{{ item.destination }}</small>
                      </div>
                    </section>
                    <section v-if="plan.presentation.approval.contract.commands.length" class="knowledge-approval-contract-section">
                      <h4>执行命令</h4>
                      <div v-for="(item, index) in plan.presentation.approval.contract.commands" :key="`command-${index}`" class="knowledge-approval-contract-item">
                        <code data-no-i18n>{{ item.command }}</code>
                        <p data-no-i18n>{{ item.purpose }}</p>
                        <small v-if="item.expectedEffect" data-no-i18n>预期影响：{{ item.expectedEffect }}</small>
                      </div>
                    </section>
                    <section v-if="plan.presentation.approval.contract.changes.length" class="knowledge-approval-contract-section">
                      <h4>配置、数据或外部环境变更</h4>
                      <div v-for="(item, index) in plan.presentation.approval.contract.changes" :key="`change-${index}`" class="knowledge-approval-contract-item">
                        <b data-no-i18n>{{ item.target }}</b>
                        <p data-no-i18n>{{ item.change }}</p>
                        <small v-if="item.impact" data-no-i18n>影响：{{ item.impact }}</small>
                      </div>
                    </section>
                    <div class="knowledge-approval-contract-grid">
                      <section>
                        <h4>批准后如何验证</h4>
                        <ul><li v-for="(item, index) in plan.presentation.approval.contract.validation" :key="`validation-${index}`" data-no-i18n>{{ item }}</li></ul>
                      </section>
                      <section>
                        <h4>失败时如何回退</h4>
                        <ul><li v-for="(item, index) in plan.presentation.approval.contract.rollback" :key="`rollback-${index}`" data-no-i18n>{{ item }}</li></ul>
                      </section>
                      <section>
                        <h4>明确不在本次范围</h4>
                        <ul><li v-for="(item, index) in plan.presentation.approval.contract.outOfScope" :key="`scope-${index}`" data-no-i18n>{{ item }}</li></ul>
                      </section>
                    </div>
                  </div>
                  <div v-if="plan.approval.latest" class="knowledge-approval-latest">
                    <span>最近记录 · <time data-no-i18n>{{ formatDate(plan.approval.latest.createdAt) }}</time></span>
                    <b data-no-i18n>{{ plan.approval.latest.text }}</b>
                  </div>
                  <v-textarea
                    v-model="approvalDrafts[plan.id]"
                    label="审批建议"
                    placeholder="例如：建议先补充回归范围，再进入下一步。"
                    persistent-hint
                    hint="提交后由 Agent 判断如何处理，不会直接改变计划状态。"
                    variant="outlined"
                    rows="3"
                    :counter="2000"
                    :maxlength="2000"
                    :disabled="approvalPending[plan.id]"
                  />
                  <v-alert
                    v-if="approvalNotices[plan.id]"
                    :type="approvalNotices[plan.id].tone"
                    variant="tonal"
                    density="compact"
                    data-no-i18n
                  >
                    {{ approvalNotices[plan.id].text }}
                  </v-alert>
                  <div class="knowledge-approval-actions">
                    <span>意见会关联当前 planId 与 stepId，QQ 和本页面可使用同一记录接口。</span>
                    <v-btn
                      color="primary"
                      prepend-icon="mdi-send-check-outline"
                      :loading="approvalPending[plan.id]"
                      :disabled="!String(approvalDrafts[plan.id] || '').trim() || !gatewayId"
                      @click="sendApprovalSuggestion(plan)"
                    >
                      提交给 Agent
                    </v-btn>
                  </div>
                </section>
            </div>
          </div>
        </article>

        <div v-if="!loading && !visiblePlansForView.length" class="knowledge-empty">
          <v-icon size="32">mdi-clipboard-text-off-outline</v-icon>
          <b>没有匹配的计划</b>
          <span>{{ activeView === "current" ? t("当前没有匹配的进行中计划。") : activeView === "archived" ? t("当前没有匹配的已归档计划。") : t("可以清空搜索，或等待 Agent 通过 Manager 写入计划。") }}</span>
        </div>
      </div>

      <div v-if="roleId && showsMemoryList" class="knowledge-memory-grid">
        <div v-if="activeView === 'current' || activeView === 'archived'" class="knowledge-subsection-heading knowledge-memory-heading">
          <v-icon size="20">{{ activeView === "current" ? "mdi-memory" : "mdi-bookshelf" }}</v-icon>
          <b>{{ activeView === "current" ? t("近期记忆") : t("沉淀记忆") }}</b>
        </div>
        <article
          v-for="memory in visibleMemoryForView"
          :key="memory.id"
          class="knowledge-memory-card"
        >
          <div class="knowledge-memory-icon">
            <v-icon>{{ activeView === "archived" ? "mdi-bookshelf" : "mdi-memory" }}</v-icon>
          </div>
          <div class="knowledge-memory-copy">
            <div class="knowledge-memory-head">
              <div>
                <div class="knowledge-kicker">{{ activeView === "archived" ? "CONSOLIDATED" : "RECENT" }}</div>
                <h2 data-no-i18n>{{ memory.title }}</h2>
              </div>
              <time data-no-i18n>{{ formatDate(memory.updatedAt) }}</time>
            </div>
            <p data-no-i18n>{{ memory.content }}</p>
            <div v-if="memory.source?.summary" class="knowledge-source" data-no-i18n>{{ memory.source.summary }}</div>
            <div v-if="memory.keywords.length" class="knowledge-keywords">
              <v-chip v-for="keyword in memory.keywords" :key="keyword" data-no-i18n size="x-small" variant="outlined">{{ keyword }}</v-chip>
            </div>
          </div>
        </article>

        <div
          v-if="!loading && !visibleMemoryForView.length"
          class="knowledge-empty"
        >
          <v-icon size="32">mdi-book-open-blank-variant-outline</v-icon>
          <b>没有匹配的记忆</b>
          <span>当前视图只展示 Manager 返回的只读人格记忆。</span>
        </div>
      </div>
    </v-card>
  </div>
</template>
