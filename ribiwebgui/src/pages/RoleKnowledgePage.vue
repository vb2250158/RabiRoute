<script setup lang="ts">
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import {
  PLAN_FEEDBACK_ATTACHMENT_MAX_BYTES,
  PLAN_FEEDBACK_ATTACHMENTS_MAX_BYTES,
  PLAN_FEEDBACK_MAX_ATTACHMENTS,
  type PlanFeedbackAttachmentUpload
} from "@shared/planFeedbackContract";
import { useI18n } from "../i18n";
import { managerEventSource, managerResourceUrl } from "../managerApi";
import { activePlanIdAtAnchor, directoryScrollTopForItem } from "../planDirectoryScrollSync";
import { loadPlanFeedback, loadRoleKnowledge, submitPlanFeedback } from "../roleKnowledgeClient";
import { formatPlanVideoDuration, planCardStyle, planDescriptionForDisplay, planStatusStyle, plansForKnowledgeView, planTitleForDirectory } from "../planPresentationStyles";
import type { PlanKnowledgeView } from "../planPresentationStyles";
import { useGatewayStore } from "../stores/gatewayStore";
import type { PlanAttachmentPresentation } from "@shared/planAttachmentContract";
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
const planVideoDurations = reactive<Record<string, number>>({});
const activeDirectoryPlanId = ref("");
const approvalDrafts = reactive<Record<string, string>>({});
const approvalPending = reactive<Record<string, boolean>>({});
const approvalDeliveryPending = reactive<Record<string, boolean>>({});
const approvalRequestIds = reactive<Record<string, string>>({});
const approvalNotices = reactive<Record<string, { tone: "success" | "warning" | "error"; text: string }>>({});
const submittedApprovalTexts = new Map<string, string>();
type ApprovalAttachmentDraft = {
  id: string;
  file: File;
  name: string;
  size: number;
  mimeType: string;
  kind: "file" | "image";
  previewUrl?: string;
};
const approvalAttachments = reactive<Record<string, ApprovalAttachmentDraft[]>>({});
const submittedApprovalAttachments = new Map<string, ApprovalAttachmentDraft[]>();
const approvalFileInput = ref<HTMLInputElement | null>(null);
const attachmentTargetPlanId = ref("");
const planAttachmentPreview = ref<{ name: string; url: string; kind: "image" | "video" } | null>(null);
const knowledgeToolbar = ref<HTMLElement | null>(null);
const planDirectoryList = ref<HTMLElement | null>(null);
let requestVersion = 0;
let managerEvents: EventSource | null = null;
let planCardObserver: IntersectionObserver | null = null;
let toolbarResizeObserver: ResizeObserver | null = null;
let planDirectorySyncFrame = 0;
let planObserverRefreshFrame = 0;
let planDirectoryMounted = false;
let usesPlanScrollFallback = false;
let directoryJumpTargetId = "";
let directoryJumpSettleTimer = 0;

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

function planReadingAnchorTop(): number {
  if (typeof window === "undefined") return 0;
  if (window.matchMedia?.("(max-width: 960px)").matches) return 16;
  const toolbarBottom = knowledgeToolbar.value?.getBoundingClientRect().bottom || 140;
  return Math.max(80, Math.min(toolbarBottom + 12, window.innerHeight * 0.45));
}

function syncActiveDirectoryPlan(): void {
  planDirectorySyncFrame = 0;
  if (directoryJumpTargetId) return;
  const rects = visiblePlansForView.value.flatMap((plan) => {
    const element = document.getElementById(planCardDomId(plan.id));
    if (!element) return [];
    const rect = element.getBoundingClientRect();
    return [{ id: plan.id, top: rect.top, bottom: rect.bottom }];
  });
  const nextPlanId = activePlanIdAtAnchor(rects, planReadingAnchorTop(), activeDirectoryPlanId.value);
  if (nextPlanId && nextPlanId !== activeDirectoryPlanId.value) activeDirectoryPlanId.value = nextPlanId;
}

function scheduleActiveDirectoryPlanSync(): void {
  if (directoryJumpTargetId || planDirectorySyncFrame || typeof window === "undefined") return;
  planDirectorySyncFrame = window.requestAnimationFrame(syncActiveDirectoryPlan);
}

function releaseDirectoryJumpTarget(syncCurrentPlan = true): void {
  if (typeof window !== "undefined") {
    window.removeEventListener("scroll", waitForDirectoryJumpSettle);
    if (directoryJumpSettleTimer) window.clearTimeout(directoryJumpSettleTimer);
  }
  directoryJumpSettleTimer = 0;
  directoryJumpTargetId = "";
  if (syncCurrentPlan) scheduleActiveDirectoryPlanSync();
}

function waitForDirectoryJumpSettle(): void {
  if (!directoryJumpTargetId) return;
  if (directoryJumpSettleTimer) window.clearTimeout(directoryJumpSettleTimer);
  directoryJumpSettleTimer = window.setTimeout(releaseDirectoryJumpTarget, 120);
}

function holdDirectoryJumpTarget(planId: string, smooth: boolean): void {
  releaseDirectoryJumpTarget(false);
  directoryJumpTargetId = planId;
  if (smooth) window.addEventListener("scroll", waitForDirectoryJumpSettle, { passive: true });
  directoryJumpSettleTimer = window.setTimeout(releaseDirectoryJumpTarget, smooth ? 240 : 0);
}

function enablePlanScrollFallback(enabled: boolean): void {
  if (usesPlanScrollFallback === enabled || typeof window === "undefined") return;
  usesPlanScrollFallback = enabled;
  if (enabled) window.addEventListener("scroll", scheduleActiveDirectoryPlanSync, { passive: true });
  else window.removeEventListener("scroll", scheduleActiveDirectoryPlanSync);
}

function rebuildPlanCardObserver(): void {
  planObserverRefreshFrame = 0;
  planCardObserver?.disconnect();
  planCardObserver = null;
  enablePlanScrollFallback(false);
  if (!planDirectoryMounted || !visiblePlansForView.value.length) return;

  const cardElements = visiblePlansForView.value.flatMap((plan) => {
    const element = document.getElementById(planCardDomId(plan.id));
    return element ? [element] : [];
  });
  if (!cardElements.length) return;

  if (typeof IntersectionObserver === "undefined") {
    enablePlanScrollFallback(true);
    scheduleActiveDirectoryPlanSync();
    return;
  }

  const anchorTop = planReadingAnchorTop();
  const bandHeight = Math.max(72, Math.min(160, window.innerHeight - anchorTop));
  const bottomMargin = Math.max(0, window.innerHeight - anchorTop - bandHeight);
  planCardObserver = new IntersectionObserver(scheduleActiveDirectoryPlanSync, {
    rootMargin: `-${Math.round(anchorTop)}px 0px -${Math.round(bottomMargin)}px 0px`,
    threshold: [0, 0.01]
  });
  for (const element of cardElements) planCardObserver.observe(element);
  scheduleActiveDirectoryPlanSync();
}

function schedulePlanCardObserverRefresh(): void {
  if (planObserverRefreshFrame || typeof window === "undefined") return;
  planObserverRefreshFrame = window.requestAnimationFrame(rebuildPlanCardObserver);
}

function keepActiveDirectoryLinkVisible(): void {
  const list = planDirectoryList.value;
  if (!list || !activeDirectoryPlanId.value) return;
  const link = Array.from(list.querySelectorAll<HTMLElement>("[data-plan-directory-id]"))
    .find((item) => item.dataset.planDirectoryId === activeDirectoryPlanId.value);
  if (!link) return;
  const viewport = list.getBoundingClientRect();
  const item = link.getBoundingClientRect();
  const nextScrollTop = directoryScrollTopForItem({
    scrollTop: list.scrollTop,
    viewportTop: viewport.top,
    viewportBottom: viewport.bottom,
    itemTop: item.top,
    itemBottom: item.bottom,
    padding: 6
  });
  if (nextScrollTop !== null) list.scrollTop = nextScrollTop;
}

watch(
  () => visiblePlansForView.value.map((plan) => plan.id).join("\u001f"),
  () => {
    if (!visiblePlansForView.value.some((plan) => plan.id === activeDirectoryPlanId.value)) {
      activeDirectoryPlanId.value = visiblePlansForView.value[0]?.id || "";
    }
    void nextTick(schedulePlanCardObserverRefresh);
  },
  { immediate: true }
);

watch(activeDirectoryPlanId, () => void nextTick(keepActiveDirectoryLinkVisible), { flush: "post" });

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
    for (const plan of plans.value) applyFeedbackDeliveryState(plan.id, plan.approval.latest);
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
    if (previous && nextRoleId !== previousRoleId) resetApprovalAttachmentState();
    if (!nextRoleId || managerLoading) return;
    if (!previous || nextRoleId !== previousRoleId || previousManagerLoading === true) void refreshKnowledge();
  },
  { immediate: true }
);

function stepColor(plan: RolePlan, step: RolePlanStep): string {
  if (stepIsBlocked(plan, step)) return "error";
  if (step.status === "已完成") return "success";
  if (step.status === "进行中") return "primary";
  return "grey";
}

function currentStep(plan: RolePlan): RolePlanStep | undefined {
  return plan.steps.find((step) => step.id === plan.currentStepId)
    || plan.steps.find((step) => step.status === "进行中");
}

function blocker(plan: RolePlan): string {
  if (plan.presentation.tone !== "blocked") return "";
  return currentStep(plan)?.blockedBy || plan.blockedBy || "";
}

function stepIsBlocked(plan: RolePlan, step: RolePlanStep): boolean {
  return plan.presentation.tone === "blocked" && step.id === currentStep(plan)?.id;
}

function completedSteps(plan: RolePlan): number {
  return plan.steps.filter((step) => step.status === "已完成").length;
}

function progressValue(plan: RolePlan): number {
  return plan.steps.length ? Math.round(completedSteps(plan) * 100 / plan.steps.length) : 0;
}

function currentStepPosition(plan: RolePlan): number {
  const index = plan.steps.findIndex((step) => step.id === plan.currentStepId);
  return index >= 0 ? index + 1 : 0;
}

function formatDate(value: string | undefined): string {
  if (!value) return t("未记录");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return dateFormatter.value.format(date);
}

function planAttachmentUrl(planId: string, attachmentId: string): string {
  return managerResourceUrl(
    `/api/roles/${encodeURIComponent(roleId.value)}/plans/${encodeURIComponent(planId)}/attachments/${encodeURIComponent(attachmentId)}`
  );
}

function planVideoThumbnailUrl(planId: string, attachmentId: string): string {
  return `${planAttachmentUrl(planId, attachmentId)}#t=0.001`;
}

function planVideoDurationKey(planId: string, attachmentId: string): string {
  return `${roleId.value}:${planId}:${attachmentId}`;
}

function capturePlanVideoDuration(planId: string, attachmentId: string, event: Event): void {
  const video = event.currentTarget as HTMLVideoElement;
  if (!Number.isFinite(video.duration) || video.duration < 0) return;
  planVideoDurations[planVideoDurationKey(planId, attachmentId)] = video.duration;
}

function displayedPlanVideoDuration(planId: string, attachmentId: string): string {
  return formatPlanVideoDuration(planVideoDurations[planVideoDurationKey(planId, attachmentId)]);
}

function openPlanMediaPreview(plan: RolePlan, attachment: PlanAttachmentPresentation): void {
  if (attachment.kind !== "image" && attachment.kind !== "video") return;
  planAttachmentPreview.value = {
    name: attachment.name,
    url: planAttachmentUrl(plan.id, attachment.id),
    kind: attachment.kind
  };
}

function closePlanMediaPreview(): void {
  planAttachmentPreview.value = null;
}

function feedbackRecordLabel(feedback: RolePlanFeedback): string {
  if (feedback.author === "agent") return isEnglish.value ? "Agent reply" : "Agent 回复";
  if (feedback.author === "system") return isEnglish.value ? "System record" : "系统记录";
  return isEnglish.value ? "Your feedback" : "你的意见";
}

function approvalRecordsForDisplay(plan: RolePlan): RolePlanFeedback[] {
  const records = plan.approval.records?.length
    ? plan.approval.records
    : plan.approval.latest
      ? [plan.approval.latest]
      : [];
  return [...records].reverse();
}

function planCardDomId(planId: string): string {
  return `plan-card-${encodeURIComponent(planId)}`;
}

function togglePlan(plan: RolePlan): void {
  const expanded = !expandedPlans[plan.id];
  expandedPlans[plan.id] = expanded;
  if (expanded && plan.presentation.approval.state !== "none") void refreshPlanApproval(plan.id);
}

function planDirectoryStyle(plan: RolePlan): Record<string, string> {
  return { "--plan-tone": plan.presentation.palette.accent };
}

function jumpToPlan(event: MouseEvent, plan: RolePlan): void {
  event.preventDefault();
  const target = document.getElementById(planCardDomId(plan.id));
  if (!target) return;
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  holdDirectoryJumpTarget(plan.id, !reduceMotion);
  activeDirectoryPlanId.value = plan.id;
  target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  target.focus({ preventScroll: true });
}

function isApprovalStep(plan: RolePlan, step: RolePlanStep): boolean {
  if (plan.presentation.approval.state === "none") return false;
  return step.id === (plan.presentation.approval.stepId || currentStep(plan)?.id);
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

function approvalAttachmentsFor(planId: string): ApprovalAttachmentDraft[] {
  return approvalAttachments[planId] || [];
}

function approvalAttachmentError(planId: string, zh: string, en: string): void {
  approvalNotices[planId] = { tone: "error", text: isEnglish.value ? en : zh };
}

function attachmentDraftId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function clipboardImageName(mimeType: string, index: number): string {
  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : mimeType === "image/gif" ? "gif" : "png";
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `clipboard-${stamp}${index > 0 ? `-${index + 1}` : ""}.${extension}`;
}

function addApprovalFiles(planId: string, files: File[], fromClipboard = false): void {
  if (!files.length || approvalPending[planId] || approvalDeliveryPending[planId]) return;
  const current = approvalAttachmentsFor(planId);
  if (current.length + files.length > PLAN_FEEDBACK_MAX_ATTACHMENTS) {
    approvalAttachmentError(
      planId,
      `最多只能添加 ${PLAN_FEEDBACK_MAX_ATTACHMENTS} 个附件。`,
      `You can attach at most ${PLAN_FEEDBACK_MAX_ATTACHMENTS} files.`
    );
    return;
  }
  const oversized = files.find((file) => file.size > PLAN_FEEDBACK_ATTACHMENT_MAX_BYTES);
  if (oversized) {
    approvalAttachmentError(
      planId,
      `附件「${oversized.name || "未命名文件"}」超过 10 MB。`,
      `Attachment “${oversized.name || "unnamed file"}” exceeds 10 MB.`
    );
    return;
  }
  const total = current.reduce((sum, item) => sum + item.size, 0) + files.reduce((sum, file) => sum + file.size, 0);
  if (total > PLAN_FEEDBACK_ATTACHMENTS_MAX_BYTES) {
    approvalAttachmentError(planId, "附件总大小不能超过 25 MB。", "Attachments cannot exceed 25 MB in total.");
    return;
  }
  const additions = files.map((file, index) => {
    const kind = file.type.startsWith("image/") ? "image" : "file";
    return {
      id: attachmentDraftId(),
      file: markRaw(file),
      name: fromClipboard ? clipboardImageName(file.type, index) : file.name || `attachment-${current.length + index + 1}`,
      size: file.size,
      mimeType: file.type,
      kind,
      previewUrl: kind === "image" ? URL.createObjectURL(file) : undefined
    } satisfies ApprovalAttachmentDraft;
  });
  approvalAttachments[planId] = [...current, ...additions];
  if (approvalNotices[planId]?.tone === "error") delete approvalNotices[planId];
}

function openApprovalAttachmentPicker(planId: string): void {
  if (approvalPending[planId] || approvalDeliveryPending[planId]) return;
  attachmentTargetPlanId.value = planId;
  if (approvalFileInput.value) {
    approvalFileInput.value.value = "";
    approvalFileInput.value.click();
  }
}

function handleApprovalFileSelection(event: Event): void {
  const input = event.target as HTMLInputElement;
  const planId = attachmentTargetPlanId.value;
  if (planId) addApprovalFiles(planId, Array.from(input.files || []));
  input.value = "";
}

function handleApprovalPaste(planId: string, event: ClipboardEvent): void {
  const images = Array.from(event.clipboardData?.items || [])
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .flatMap((item) => {
      const file = item.getAsFile();
      return file ? [file] : [];
    });
  if (!images.length) return;
  if (!event.clipboardData?.getData("text/plain")) event.preventDefault();
  addApprovalFiles(planId, images, true);
}

function releaseAttachmentDrafts(drafts: ApprovalAttachmentDraft[]): void {
  for (const draft of drafts) {
    if (draft.previewUrl) URL.revokeObjectURL(draft.previewUrl);
  }
}

function removeApprovalAttachment(planId: string, attachmentId: string): void {
  if (approvalPending[planId] || approvalDeliveryPending[planId]) return;
  const current = approvalAttachmentsFor(planId);
  const removed = current.find((item) => item.id === attachmentId);
  if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
  approvalAttachments[planId] = current.filter((item) => item.id !== attachmentId);
}

function takeApprovalAttachments(planId: string): ApprovalAttachmentDraft[] {
  const current = approvalAttachmentsFor(planId);
  approvalAttachments[planId] = [];
  return current;
}

function clearApprovalAttachments(planId: string): void {
  releaseAttachmentDrafts(approvalAttachmentsFor(planId));
  approvalAttachments[planId] = [];
}

function clearSubmittedApprovalAttachments(planId: string): void {
  releaseAttachmentDrafts(submittedApprovalAttachments.get(planId) || []);
  submittedApprovalAttachments.delete(planId);
}

function restoreSubmittedApprovalAttachments(planId: string): void {
  const submitted = submittedApprovalAttachments.get(planId);
  if (!submitted) return;
  approvalAttachments[planId] = submitted;
  submittedApprovalAttachments.delete(planId);
}

function resetApprovalAttachmentState(): void {
  for (const drafts of Object.values(approvalAttachments)) releaseAttachmentDrafts(drafts);
  for (const drafts of submittedApprovalAttachments.values()) releaseAttachmentDrafts(drafts);
  for (const key of Object.keys(approvalAttachments)) delete approvalAttachments[key];
  for (const key of Object.keys(approvalDeliveryPending)) delete approvalDeliveryPending[key];
  for (const key of Object.keys(approvalRequestIds)) delete approvalRequestIds[key];
  submittedApprovalTexts.clear();
  submittedApprovalAttachments.clear();
  attachmentTargetPlanId.value = "";
}

function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} KB`;
  return `${Math.round(size / 1024 / 102.4) / 10} MB`;
}

function attachmentContentBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").split(",", 2)[1] || "");
    reader.onerror = () => reject(reader.error || new Error("Unable to read attachment."));
    reader.readAsDataURL(file);
  });
}

async function approvalAttachmentUploads(planId: string): Promise<PlanFeedbackAttachmentUpload[]> {
  return Promise.all(approvalAttachmentsFor(planId).map(async (attachment) => ({
    kind: attachment.kind,
    name: attachment.name,
    mimeType: attachment.mimeType || undefined,
    contentBase64: await attachmentContentBase64(attachment.file)
  })));
}

function canSubmitApproval(planId: string): boolean {
  return !approvalPending[planId]
    && !approvalDeliveryPending[planId]
    && Boolean(gatewayId.value)
    && Boolean(String(approvalDrafts[planId] || "").trim());
}

function handleApprovalEnter(event: KeyboardEvent, plan: RolePlan): void {
  if (event.isComposing || event.keyCode === 229 || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
  event.preventDefault();
  if (!canSubmitApproval(plan.id)) return;
  void sendApprovalSuggestion(plan);
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
    approvalDeliveryPending[planId] = false;
    approvalNotices[planId] = { tone: "success", text: t("审批建议已记录并交给 Agent 处理。") };
    approvalRequestIds[planId] = "";
    submittedApprovalTexts.delete(planId);
    clearSubmittedApprovalAttachments(planId);
    return;
  }
  if (feedback.deliveryStatus === "failed") {
    approvalDeliveryPending[planId] = false;
    const submittedText = submittedApprovalTexts.get(planId);
    if (submittedText && !approvalDrafts[planId]) approvalDrafts[planId] = submittedText;
    restoreSubmittedApprovalAttachments(planId);
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
  planDirectoryMounted = true;
  window.addEventListener("resize", schedulePlanCardObserverRefresh, { passive: true });
  if (typeof ResizeObserver !== "undefined" && knowledgeToolbar.value) {
    toolbarResizeObserver = new ResizeObserver(schedulePlanCardObserverRefresh);
    toolbarResizeObserver.observe(knowledgeToolbar.value);
  }
  schedulePlanCardObserverRefresh();
  managerEvents = managerEventSource("/api/events");
  managerEvents.addEventListener("plan_feedback_changed", (raw) => {
    try {
      const data = JSON.parse((raw as MessageEvent).data || "{}") as { roleId?: string; planId?: string };
      if (data.roleId === roleId.value && data.planId) void refreshPlanApproval(data.planId);
    } catch {
      // Ignore malformed event payloads and keep the latest valid plan snapshot.
    }
  });
});

onBeforeUnmount(() => {
  planDirectoryMounted = false;
  releaseDirectoryJumpTarget(false);
  planCardObserver?.disconnect();
  toolbarResizeObserver?.disconnect();
  enablePlanScrollFallback(false);
  window.removeEventListener("resize", schedulePlanCardObserverRefresh);
  if (planDirectorySyncFrame) window.cancelAnimationFrame(planDirectorySyncFrame);
  if (planObserverRefreshFrame) window.cancelAnimationFrame(planObserverRefreshFrame);
  managerEvents?.close();
  resetApprovalAttachmentState();
});

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
    const attachments = await approvalAttachmentUploads(plan.id);
    const result = await submitPlanFeedback({
      roleId: roleId.value,
      planId: plan.id,
      gatewayId: gatewayId.value,
      stepId: plan.presentation.approval.stepId,
      feedbackId: feedbackRequestId(plan.id),
      text,
      attachments,
      source: "webgui"
    });
    const existingRecords = plan.approval.records?.length
      ? plan.approval.records
      : plan.approval.latest
        ? [plan.approval.latest]
        : [];
    const isExisting = existingRecords.some((feedback) => feedback.id === result.id);
    applyPlanApproval(plan.id, {
      count: plan.approval.count + (isExisting ? 0 : 1),
      latest: result,
      records: [result, ...existingRecords.filter((feedback) => feedback.id !== result.id)]
    });
    if (result.deliveryStatus === "failed") {
      approvalNotices[plan.id] = {
        tone: "warning",
        text: t("审批建议已记录，但通知 Agent 失败；可以保留内容后重试。")
      };
    } else if (result.deliveryStatus === "pending") {
      submittedApprovalTexts.set(plan.id, text);
      submittedApprovalAttachments.set(plan.id, takeApprovalAttachments(plan.id));
      approvalDeliveryPending[plan.id] = true;
      approvalDrafts[plan.id] = "";
      approvalNotices[plan.id] = { tone: "success", text: t("审批建议已记录，正在后台通知 Agent。") };
    } else {
      approvalDrafts[plan.id] = "";
      approvalRequestIds[plan.id] = "";
      submittedApprovalTexts.delete(plan.id);
      clearApprovalAttachments(plan.id);
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
    <input
      ref="approvalFileInput"
      class="knowledge-approval-file-input"
      type="file"
      multiple
      @change="handleApprovalFileSelection"
    >
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

    <div
      class="knowledge-browser-layout"
      :class="{ 'has-plan-directory': roleId && showsPlanList && visiblePlansForView.length }"
    >
      <nav
        v-if="roleId && showsPlanList && visiblePlansForView.length"
        class="knowledge-plan-directory"
        :aria-label="t('计划目录')"
      >
        <div class="knowledge-plan-directory-head">
          <div>
            <v-icon size="18">mdi-format-list-bulleted-square</v-icon>
            <b>计划目录</b>
          </div>
          <span>{{ visiblePlansForView.length }}</span>
        </div>
        <p>点击计划快速跳转</p>
        <div ref="planDirectoryList" class="knowledge-plan-directory-list">
          <a
            v-for="plan in visiblePlansForView"
            :key="`directory-${plan.id}`"
            :href="`#${planCardDomId(plan.id)}`"
            class="knowledge-plan-directory-link"
            :class="{ active: activeDirectoryPlanId === plan.id }"
            :data-tone="plan.presentation.tone"
            :style="planDirectoryStyle(plan)"
            :aria-current="activeDirectoryPlanId === plan.id ? 'location' : undefined"
            :data-plan-directory-id="plan.id"
            @click="jumpToPlan($event, plan)"
          >
            <span
              class="knowledge-plan-directory-status"
              :style="planStatusStyle(plan.presentation.palette)"
              :title="t(plan.presentation.status)"
            >{{ t(plan.presentation.status) }}</span>
            <span class="knowledge-plan-directory-copy">
              <b :title="plan.title" data-no-i18n>{{ planTitleForDirectory(plan.title) }}</b>
            </span>
          </a>
        </div>
      </nav>

      <v-card class="app-card knowledge-browser" variant="flat">
      <div ref="knowledgeToolbar" class="knowledge-toolbar">
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
        <div v-if="visiblePlansForView.length" class="knowledge-plan-cards">
            <article
              v-for="(plan, planIndex) in visiblePlansForView"
              :id="planCardDomId(plan.id)"
              :key="plan.id"
              class="knowledge-plan-card"
              :class="{ expanded: expandedPlans[plan.id] }"
              :data-tone="plan.presentation.tone"
              :style="planCardStyle(plan.presentation.palette)"
              tabindex="-1"
            >
          <div class="knowledge-plan-accent" />
          <div class="knowledge-plan-main">
            <div class="knowledge-plan-head">
              <div class="knowledge-plan-identity-row">
                <div class="knowledge-plan-sequence" aria-hidden="true">
                  <span>{{ t("计划项") }}</span>
                  <b>{{ String(planIndex + 1).padStart(2, "0") }}</b>
                </div>
                <div class="knowledge-plan-title-copy">
                  <div class="knowledge-kicker" data-no-i18n>{{ plan.project?.name || plan.kind || "PLAN" }}</div>
                  <h2 data-no-i18n>{{ plan.title }}</h2>
                </div>
              </div>
              <v-chip :style="planStatusStyle(plan.presentation.palette)" variant="flat" size="small">{{ plan.presentation.status }}</v-chip>
            </div>

            <div v-if="planDescriptionForDisplay(plan)" class="knowledge-plan-focus">
              <span>计划描述</span>
              <p data-no-i18n>{{ planDescriptionForDisplay(plan) }}</p>
            </div>

            <section v-if="plan.attachments.length" class="knowledge-plan-attachments" :aria-label="t('计划附件')">
              <div class="knowledge-plan-attachments-head">
                <span><v-icon size="16">mdi-paperclip</v-icon>{{ t("计划附件") }}</span>
                <small>{{ plan.attachments.length }}</small>
              </div>
              <div class="knowledge-plan-attachment-grid">
                <button
                  v-for="attachment in plan.attachments.filter((item) => item.kind === 'image' || item.kind === 'video')"
                  :key="attachment.id"
                  type="button"
                  class="knowledge-plan-attachment media"
                  :class="attachment.kind"
                  :aria-label="`${t(attachment.kind === 'video' ? '查看视频预览' : '查看图片预览')}：${attachment.name}`"
                  @click="openPlanMediaPreview(plan, attachment)"
                >
                  <span class="knowledge-plan-attachment-visual">
                    <video
                      v-if="attachment.kind === 'video'"
                      :src="planVideoThumbnailUrl(plan.id, attachment.id)"
                      preload="metadata"
                      muted
                      playsinline
                      aria-hidden="true"
                      @loadedmetadata="capturePlanVideoDuration(plan.id, attachment.id, $event)"
                    ></video>
                    <img
                      v-else
                      :src="planAttachmentUrl(plan.id, attachment.id)"
                      :alt="attachment.name"
                      loading="lazy"
                      data-no-i18n
                    >
                    <span class="knowledge-plan-attachment-overlay">
                      <v-icon v-if="attachment.kind === 'image'" size="20">mdi-magnify-plus-outline</v-icon>
                      {{ t(attachment.kind === "video" ? "点击预览视频" : "点击查看大图") }}
                    </span>
                    <span v-if="attachment.kind === 'video'" class="knowledge-plan-video-play" aria-hidden="true">
                      <v-icon size="21">mdi-play</v-icon>
                    </span>
                    <span v-if="attachment.kind === 'video'" class="knowledge-plan-video-duration" data-no-i18n aria-hidden="true">
                      {{ displayedPlanVideoDuration(plan.id, attachment.id) }}
                    </span>
                  </span>
                  <span class="knowledge-plan-attachment-meta">
                    <b data-no-i18n>{{ attachment.name }}</b>
                    <small data-no-i18n>{{ formatAttachmentSize(attachment.size) }}</small>
                  </span>
                </button>
                <a
                  v-for="attachment in plan.attachments.filter((item) => item.kind === 'file')"
                  :key="attachment.id"
                  class="knowledge-plan-attachment file"
                  :href="planAttachmentUrl(plan.id, attachment.id)"
                  target="_blank"
                  rel="noopener noreferrer"
                  :aria-label="`${t('打开附件')}：${attachment.name}`"
                >
                  <span class="knowledge-plan-attachment-file-icon"><v-icon size="24">mdi-file-outline</v-icon></span>
                  <span class="knowledge-plan-attachment-meta">
                    <b data-no-i18n>{{ attachment.name }}</b>
                    <small data-no-i18n>{{ attachment.mimeType || t("文件") }} · {{ formatAttachmentSize(attachment.size) }}</small>
                  </span>
                  <v-icon size="17">mdi-open-in-new</v-icon>
                </a>
              </div>
            </section>

            <div class="knowledge-plan-summary">
              <div class="knowledge-plan-current" :class="{ blocked: Boolean(blocker(plan)) }">
                <v-icon size="19">{{ blocker(plan) ? "mdi-alert-circle-outline" : "mdi-progress-wrench" }}</v-icon>
                <div>
                  <span>{{ blocker(plan) ? "当前阻塞" : "当前步骤" }}</span>
                  <b v-if="currentStep(plan)?.title || plan.currentStep" data-no-i18n>{{ currentStep(plan)?.title || plan.currentStep }}</b>
                  <b v-else>暂无进行中的步骤</b>
                  <small v-if="plan.steps.length">{{ currentStepPosition(plan) || "—" }}/{{ plan.steps.length }} · {{ t("执行步骤") }}</small>
                </div>
              </div>
              <div class="knowledge-plan-timing">
                <div>
                  <span>更新时间</span>
                  <b data-no-i18n>{{ formatDate(plan.updatedAt) }}</b>
                </div>
                <div v-if="plan.dueAt">
                  <span>截止时间</span>
                  <b data-no-i18n>{{ formatDate(plan.dueAt) }}</b>
                </div>
              </div>
            </div>

            <v-alert v-if="blocker(plan)" data-no-i18n type="error" variant="tonal" density="compact" class="knowledge-blocker">
              {{ blocker(plan) }}
            </v-alert>

            <div v-if="plan.steps.length" class="knowledge-progress-row">
              <div class="knowledge-progress-copy">
                <span>{{ t("步骤进度") }}</span>
                <b>{{ completedSteps(plan) }}/{{ plan.steps.length }}</b>
              </div>
              <v-progress-linear :model-value="progressValue(plan)" color="secondary" height="7" rounded />
            </div>

            <div v-if="plan.keywords.length" class="knowledge-keywords">
              <v-chip v-for="keyword in plan.keywords" :key="keyword" data-no-i18n size="x-small" variant="outlined">{{ keyword }}</v-chip>
            </div>

            <button
              v-if="plan.steps.length || plan.presentation.approval.state !== 'none'"
              class="knowledge-expand"
              type="button"
              :aria-expanded="Boolean(expandedPlans[plan.id])"
              @click="togglePlan(plan)"
            >
              <span>{{ expandedPlans[plan.id] ? "收起计划详情" : plan.presentation.approval.state === "ready" ? "查看执行合同并审批" : plan.presentation.approval.state === "incomplete" ? "查看缺失的审批信息" : `查看全部 ${plan.steps.length} 个步骤` }}</span>
              <v-icon size="18">{{ expandedPlans[plan.id] ? "mdi-chevron-up" : "mdi-chevron-down" }}</v-icon>
            </button>

            <div v-if="expandedPlans[plan.id]" class="knowledge-plan-details">
              <div v-if="plan.steps.length" class="knowledge-steps">
                <div class="knowledge-steps-head">
                  <div>
                    <span>{{ t("执行计划") }}</span>
                    <b>{{ plan.steps.length }} {{ t("个步骤") }}</b>
                  </div>
                  <small>{{ completedSteps(plan) }}/{{ plan.steps.length }} {{ t("已完成") }}</small>
                </div>
                <div
                  v-for="(step, index) in plan.steps"
                  :key="step.id"
                  class="knowledge-step"
                  :class="{
                    current: step.id === plan.currentStepId,
                    completed: step.status === '已完成',
                    blocked: stepIsBlocked(plan, step),
                    'has-approval': isApprovalStep(plan, step)
                  }"
                >
                    <div class="knowledge-step-index">{{ index + 1 }}</div>
                    <div class="knowledge-step-copy">
                      <div class="knowledge-step-title-row">
                        <b data-no-i18n>{{ step.title }}</b>
                        <span v-if="step.id === plan.currentStepId">{{ blocker(plan) ? t("当前阻塞") : t("正在执行") }}</span>
                      </div>
                      <p v-if="step.detail" data-no-i18n>{{ step.detail }}</p>
                      <small v-if="step.waitingFor" data-no-i18n>等待：{{ step.waitingFor }}</small>
                      <small v-if="stepIsBlocked(plan, step) && step.blockedBy" data-no-i18n>{{ step.blockedBy }}</small>
                      <small v-if="step.status === '进行中' && step.startedAt" class="knowledge-step-time">
                        <span>{{ t("开始时间") }}</span>
                        <b data-no-i18n>{{ formatDate(step.startedAt) }}</b>
                      </small>
                      <small v-else-if="step.status === '已完成' && step.completedAt" class="knowledge-step-time">
                        <span>{{ t("完成时间") }}</span>
                        <b data-no-i18n>{{ formatDate(step.completedAt) }}</b>
                      </small>
                    </div>
                    <v-chip :color="stepColor(plan, step)" size="x-small" variant="tonal">{{ stepIsBlocked(plan, step) ? "已阻塞" : step.status }}</v-chip>
                    <section v-if="isApprovalStep(plan, step)" class="knowledge-approval-panel" :data-state="plan.presentation.approval.state">
                  <div class="knowledge-approval-head">
                    <div>
                      <span>{{ plan.presentation.approval.label }}</span>
                      <b>核对本步骤的执行边界后提交审批意见</b>
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
                  <div v-if="approvalRecordsForDisplay(plan).length" class="knowledge-approval-history" :aria-label="t('审批意见记录')">
                    <article
                      v-for="feedback in approvalRecordsForDisplay(plan)"
                      :key="feedback.id"
                      class="knowledge-approval-record"
                      :data-author="feedback.author"
                    >
                      <span>{{ feedbackRecordLabel(feedback) }} · <time data-no-i18n>{{ formatDate(feedback.createdAt) }}</time></span>
                      <b data-no-i18n>{{ feedback.text }}</b>
                      <div v-if="(feedback.attachments || []).length" class="knowledge-approval-record-attachments">
                        <v-chip
                          v-for="attachment in feedback.attachments"
                          :key="`${feedback.id}-${attachment.sha256}`"
                          prepend-icon="mdi-paperclip"
                          size="x-small"
                          variant="tonal"
                          data-no-i18n
                        >
                          {{ attachment.name }} · {{ formatAttachmentSize(attachment.size) }}
                        </v-chip>
                      </div>
                    </article>
                  </div>
                  <v-textarea
                    v-model="approvalDrafts[plan.id]"
                    label="审批建议"
                    placeholder="例如：建议先补充回归范围，再进入下一步。"
                    persistent-hint
                    hint="Enter 直接提交，Shift+Enter 换行；提交后由 Agent 判断如何处理，不会直接改变计划状态。"
                    variant="outlined"
                    rows="3"
                    :counter="2000"
                    :maxlength="2000"
                    :disabled="approvalPending[plan.id] || approvalDeliveryPending[plan.id]"
                    @keydown.enter="handleApprovalEnter($event, plan)"
                    @paste="handleApprovalPaste(plan.id, $event)"
                  />
                  <div class="knowledge-approval-attachment-tools">
                    <v-btn
                      prepend-icon="mdi-paperclip-plus"
                      variant="tonal"
                      size="small"
                      :disabled="approvalPending[plan.id] || approvalDeliveryPending[plan.id]"
                      @click="openApprovalAttachmentPicker(plan.id)"
                    >
                      添加附件
                    </v-btn>
                    <span>支持选择文件，也可以在输入框中按 Ctrl+V 粘贴图片。</span>
                    <small>最多 8 个，单个不超过 10 MB，总计不超过 25 MB。</small>
                  </div>
                  <div v-if="approvalAttachmentsFor(plan.id).length" class="knowledge-approval-attachments">
                    <article
                      v-for="attachment in approvalAttachmentsFor(plan.id)"
                      :key="attachment.id"
                      class="knowledge-approval-attachment"
                      :class="{ image: attachment.kind === 'image' }"
                    >
                      <img v-if="attachment.previewUrl" :src="attachment.previewUrl" alt="">
                      <div v-else class="knowledge-approval-attachment-icon">
                        <v-icon size="22">mdi-file-outline</v-icon>
                      </div>
                      <div class="knowledge-approval-attachment-copy">
                        <b data-no-i18n>{{ attachment.name }}</b>
                        <span data-no-i18n>{{ formatAttachmentSize(attachment.size) }}</span>
                      </div>
                      <v-btn
                        icon="mdi-close"
                        variant="text"
                        size="x-small"
                        :aria-label="t('删除附件')"
                        :disabled="approvalPending[plan.id] || approvalDeliveryPending[plan.id]"
                        @click="removeApprovalAttachment(plan.id, attachment.id)"
                      />
                    </article>
                  </div>
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
                      :disabled="!canSubmitApproval(plan.id)"
                      @click="sendApprovalSuggestion(plan)"
                    >
                      提交给 Agent
                    </v-btn>
                  </div>
                    </section>
                </div>
              </div>
            </div>
              </div>
            </article>
        </div>

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

    <v-dialog
      :model-value="Boolean(planAttachmentPreview)"
      max-width="min(1120px, 94vw)"
      @update:model-value="(open) => { if (!open) closePlanMediaPreview(); }"
    >
      <v-card class="knowledge-plan-media-preview" variant="flat">
        <div class="knowledge-plan-media-preview-head">
          <div>
            <span>{{ t(planAttachmentPreview?.kind === "video" ? "视频预览" : "图片预览") }}</span>
            <b v-if="planAttachmentPreview" data-no-i18n>{{ planAttachmentPreview.name }}</b>
          </div>
          <v-btn icon="mdi-close" variant="text" :aria-label="t('关闭预览')" @click="closePlanMediaPreview" />
        </div>
        <div class="knowledge-plan-media-preview-stage">
          <video
            v-if="planAttachmentPreview?.kind === 'video'"
            :src="planAttachmentPreview.url"
            :aria-label="planAttachmentPreview.name"
            controls
            playsinline
            preload="metadata"
            data-no-i18n
          ></video>
          <img
            v-else-if="planAttachmentPreview"
            :src="planAttachmentPreview.url"
            :alt="planAttachmentPreview.name"
            data-no-i18n
          >
        </div>
      </v-card>
    </v-dialog>
  </div>
</template>
