<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "../i18n";
import { loadRoleKnowledge, submitPlanFeedback } from "../roleKnowledgeClient";
import { useGatewayStore } from "../stores/gatewayStore";
import type { RoleMemory, RolePlan, RolePlanStep } from "../types";

type KnowledgeView = "plans" | "recent" | "consolidated";

const store = useGatewayStore();
const { isEnglish, t } = useI18n();
const plans = ref<RolePlan[]>([]);
const recentMemory = ref<RoleMemory[]>([]);
const consolidatedMemory = ref<RoleMemory[]>([]);
const loading = ref(false);
const error = ref("");
const activeView = ref<KnowledgeView>("plans");
const query = ref("");
const expandedPlans = ref<Record<string, boolean>>({});
const approvalDrafts = ref<Record<string, string>>({});
const approvalPending = ref<Record<string, boolean>>({});
const approvalRequestIds = ref<Record<string, string>>({});
const approvalNotices = ref<Record<string, { tone: "success" | "warning" | "error"; text: string }>>({});
let requestVersion = 0;

const roleId = computed(() => String(store.selectedGateway?.agentRoleId || "").trim());
const gatewayId = computed(() => String(store.selectedGateway?.id || "").trim());
const roleLabel = computed(() => roleId.value || t("未绑定人格"));

const planCounts = computed(() => ({
  blocked: plans.value.filter((plan) => plan.presentation.tone === "blocked").length,
  qa: plans.value.filter((plan) => plan.presentation.tone === "qa").length,
  active: plans.value.filter((plan) => !["done", "archived"].includes(plan.presentation.tone)).length
}));

function matchesQuery(item: RolePlan | RoleMemory): boolean {
  const normalized = query.value.trim().toLowerCase();
  if (!normalized) return true;
  return [item.id, item.title, item.focus, ...item.keywords]
    .some((value) => String(value || "").toLowerCase().includes(normalized));
}

const visiblePlans = computed(() => plans.value.filter(matchesQuery));
const visibleRecentMemory = computed(() => recentMemory.value.filter(matchesQuery));
const visibleConsolidatedMemory = computed(() => consolidatedMemory.value.filter(matchesQuery));

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

function statusColor(plan: RolePlan): string {
  return ({
    blocked: "error",
    qa: "deep-purple",
    running: "success",
    pending: "warning",
    done: "blue-grey",
    archived: "grey",
    unknown: "grey"
  } as const)[plan.presentation.tone];
}

function stepColor(step: RolePlanStep): string {
  if (step.blockedBy) return "error";
  if (step.status === "已完成") return "success";
  if (step.status === "进行中") return "primary";
  return "grey";
}

function currentStep(plan: RolePlan): RolePlanStep | undefined {
  return plan.steps.find((step) => step.id === plan.currentStepId)
    || plan.steps.find((step) => step.status === "进行中");
}

function blocker(plan: RolePlan): string {
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
  return new Intl.DateTimeFormat(isEnglish.value ? "en" : "zh-CN", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function togglePlan(planId: string): void {
  expandedPlans.value = { ...expandedPlans.value, [planId]: !expandedPlans.value[planId] };
}

function feedbackRequestId(planId: string): string {
  const existing = approvalRequestIds.value[planId];
  if (existing) return existing;
  const generated = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  approvalRequestIds.value = { ...approvalRequestIds.value, [planId]: generated };
  return generated;
}

async function sendApprovalSuggestion(plan: RolePlan): Promise<void> {
  const text = String(approvalDrafts.value[plan.id] || "").trim();
  if (!text) {
    approvalNotices.value = {
      ...approvalNotices.value,
      [plan.id]: { tone: "error", text: t("请先填写审批建议。") }
    };
    return;
  }
  if (!gatewayId.value) {
    approvalNotices.value = {
      ...approvalNotices.value,
      [plan.id]: { tone: "error", text: t("当前没有可投递的 Route。") }
    };
    return;
  }
  approvalPending.value = { ...approvalPending.value, [plan.id]: true };
  const nextNotices = { ...approvalNotices.value };
  delete nextNotices[plan.id];
  approvalNotices.value = nextNotices;
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
    if (result.deliveryStatus === "failed") {
      approvalNotices.value = {
        ...approvalNotices.value,
        [plan.id]: { tone: "warning", text: t("审批建议已记录，但通知 Agent 失败；可以保留内容后重试。") }
      };
    } else {
      approvalDrafts.value = { ...approvalDrafts.value, [plan.id]: "" };
      approvalRequestIds.value = { ...approvalRequestIds.value, [plan.id]: "" };
      approvalNotices.value = {
        ...approvalNotices.value,
        [plan.id]: { tone: "success", text: t("审批建议已记录并交给 Agent 处理。") }
      };
    }
    await refreshKnowledge();
  } catch (submitError) {
    approvalNotices.value = {
      ...approvalNotices.value,
      [plan.id]: { tone: "error", text: submitError instanceof Error ? submitError.message : String(submitError) }
    };
  } finally {
    approvalPending.value = { ...approvalPending.value, [plan.id]: false };
  }
}
</script>

<template>
  <div class="page-shell knowledge-page">
    <section class="knowledge-hero app-card">
      <div class="knowledge-hero-copy">
        <div class="eyebrow">ROLE KNOWLEDGE LEDGER</div>
        <h1>计划与记忆</h1>
        <p>计划主体与记忆由 Agent 维护；数据、显示状态、排序和审批记录均来自 Rabi Manager。需要审批的计划可在卡片内提交建议。</p>
      </div>
      <div class="knowledge-identity">
        <span>当前人格</span>
        <strong data-no-i18n>{{ roleLabel }}</strong>
        <small>状态优先，组内按更新时间由新到旧</small>
      </div>
    </section>

    <div class="knowledge-metrics">
      <div class="knowledge-metric blocked"><span>阻塞中</span><b>{{ planCounts.blocked }}</b><small>需要先解除依赖</small></div>
      <div class="knowledge-metric qa"><span>待QA测试</span><b>{{ planCounts.qa }}</b><small>等待验证或验收</small></div>
      <div class="knowledge-metric active"><span>活跃计划</span><b>{{ planCounts.active }}</b><small>未完成且未归档</small></div>
      <div class="knowledge-metric memory"><span>可读记忆</span><b>{{ recentMemory.length + consolidatedMemory.length }}</b><small>近期与沉淀合计</small></div>
    </div>

    <v-card class="app-card knowledge-browser" variant="flat">
      <div class="knowledge-toolbar">
        <v-btn-toggle v-model="activeView" mandatory color="primary" density="comfortable" class="knowledge-tabs">
          <v-btn value="plans" prepend-icon="mdi-clipboard-text-clock-outline"><span>{{ isEnglish ? "Plans" : "计划" }}</span><b>{{ plans.length }}</b></v-btn>
          <v-btn value="recent" prepend-icon="mdi-memory"><span>{{ t("近期记忆") }}</span><b>{{ recentMemory.length }}</b></v-btn>
          <v-btn value="consolidated" prepend-icon="mdi-bookshelf"><span>{{ t("沉淀记忆") }}</span><b>{{ consolidatedMemory.length }}</b></v-btn>
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

      <div v-if="roleId && activeView === 'plans'" class="knowledge-list">
        <article v-for="plan in visiblePlans" :key="plan.id" class="knowledge-plan-card" :data-tone="plan.presentation.tone">
          <div class="knowledge-plan-accent" />
          <div class="knowledge-plan-main">
            <div class="knowledge-plan-head">
              <div>
                <div class="knowledge-kicker" data-no-i18n>{{ plan.project?.name || plan.kind || "PLAN" }}</div>
                <h2 data-no-i18n>{{ plan.title }}</h2>
              </div>
              <v-chip :color="statusColor(plan)" variant="tonal" size="small">{{ plan.presentation.status }}</v-chip>
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
              v-if="plan.steps.length || plan.presentation.approval.enabled"
              class="knowledge-expand"
              type="button"
              :aria-expanded="Boolean(expandedPlans[plan.id])"
              @click="togglePlan(plan.id)"
            >
              <span>{{ expandedPlans[plan.id] ? "收起计划详情" : plan.presentation.approval.enabled ? "查看步骤并填写审批建议" : `查看全部 ${plan.steps.length} 个步骤` }}</span>
              <v-icon size="18">{{ expandedPlans[plan.id] ? "mdi-chevron-up" : "mdi-chevron-down" }}</v-icon>
            </button>

            <v-expand-transition>
              <div v-if="expandedPlans[plan.id]" class="knowledge-plan-details">
                <div v-if="plan.steps.length" class="knowledge-steps">
                  <div v-for="(step, index) in plan.steps" :key="step.id" class="knowledge-step" :class="{ current: step.id === plan.currentStepId }">
                    <div class="knowledge-step-index">{{ index + 1 }}</div>
                    <div>
                      <b data-no-i18n>{{ step.title }}</b>
                      <p v-if="step.detail" data-no-i18n>{{ step.detail }}</p>
                      <small v-if="step.waitingFor" data-no-i18n>等待：{{ step.waitingFor }}</small>
                      <small v-if="step.blockedBy" data-no-i18n>{{ step.blockedBy }}</small>
                    </div>
                    <v-chip :color="stepColor(step)" size="x-small" variant="tonal">{{ step.blockedBy ? "已阻塞" : step.status }}</v-chip>
                  </div>
                </div>

                <section v-if="plan.presentation.approval.enabled" class="knowledge-approval-panel">
                  <div class="knowledge-approval-head">
                    <div>
                      <span>{{ plan.presentation.approval.label }}</span>
                      <b v-if="currentStep(plan)" data-no-i18n>{{ currentStep(plan)?.title }}</b>
                    </div>
                    <v-chip color="primary" size="x-small" variant="tonal">Manager 统一记录</v-chip>
                  </div>
                  <p>{{ plan.presentation.approval.helper }}</p>
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
                    auto-grow
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
            </v-expand-transition>
          </div>
        </article>

        <div v-if="!loading && !visiblePlans.length" class="knowledge-empty">
          <v-icon size="32">mdi-clipboard-text-off-outline</v-icon>
          <b>没有匹配的计划</b>
          <span>可以清空搜索，或等待 Agent 通过 Manager 写入计划。</span>
        </div>
      </div>

      <div v-else-if="roleId" class="knowledge-memory-grid">
        <article
          v-for="memory in activeView === 'recent' ? visibleRecentMemory : visibleConsolidatedMemory"
          :key="memory.id"
          class="knowledge-memory-card"
        >
          <div class="knowledge-memory-icon">
            <v-icon>{{ activeView === "recent" ? "mdi-memory" : "mdi-bookshelf" }}</v-icon>
          </div>
          <div class="knowledge-memory-copy">
            <div class="knowledge-memory-head">
              <div>
                <div class="knowledge-kicker">{{ activeView === "recent" ? "RECENT" : "CONSOLIDATED" }}</div>
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
          v-if="!loading && !(activeView === 'recent' ? visibleRecentMemory.length : visibleConsolidatedMemory.length)"
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
