<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  personaIdentityRelationClient,
  type IdentityEndpointAccount,
  type IdentityEvidenceRef,
  type IdentityParticipant,
  type IdentityParticipantLink,
  type IdentityRelationCard,
  type IdentityRelationStatus,
  type ConversationSituationSnapshot
} from "../persona/personaIdentityRelationClient";

const props = withDefaults(defineProps<{ roleId: string; version?: number }>(), { version: 0 });

type ParticipantForm = {
  participantId: string;
  participantKind: IdentityParticipant["kind"];
  displayName: string;
  aliasesText: string;
  status: IdentityRelationStatus;
  evidenceRefs: IdentityEvidenceRef[];
  evidenceNote: string;
};
type AccountForm = {
  platform: string;
  endpointIdentityNamespace: string;
  senderStableId: string;
  displayName: string;
  isSelf: boolean;
  participantLinks: IdentityParticipantLink[];
  evidenceNote: string;
};
type RelationForm = {
  relationId: string;
  subjectParticipantId: string;
  targetKind: IdentityRelationCard["targetKind"];
  targetId: string;
  relationship: string;
  status: IdentityRelationStatus;
  conversationKeysText: string;
  projectIdsText: string;
  evidenceRefs: IdentityEvidenceRef[];
  evidenceNote: string;
};

const loading = ref(false);
const loaded = ref(false);
const error = ref("");
const notice = ref("");
const saving = ref(false);
const endpointAccounts = ref<IdentityEndpointAccount[]>([]);
const participants = ref<IdentityParticipant[]>([]);
const relationCards = ref<IdentityRelationCard[]>([]);
const situations = ref<ConversationSituationSnapshot[]>([]);
const situationsLoading = ref(false);
const participantDialog = ref(false);
const accountDialog = ref(false);
const relationDialog = ref(false);
const participantEditing = ref(false);
const accountEditing = ref(false);
const relationEditing = ref(false);
const participantForm = ref<ParticipantForm>(emptyParticipantForm());
const accountForm = ref<AccountForm>(emptyAccountForm());
const relationForm = ref<RelationForm>(emptyRelationForm());

const statusOptions = [
  { title: "候选：只用于核对", value: "candidate" },
  { title: "已确认", value: "confirmed" },
  { title: "已纠正", value: "corrected" },
  { title: "已停用", value: "retired" }
];
const participantKindOptions = [
  { title: "个人", value: "person" },
  { title: "组织", value: "organization" },
  { title: "共享账号", value: "shared_account" },
  { title: "自动化主体", value: "automated" },
  { title: "未知", value: "unknown" }
];
const relationTargetOptions = [
  { title: "参与者", value: "participant" },
  { title: "组织", value: "organization" },
  { title: "项目", value: "project" }
];
const participantOptions = computed(() => participants.value.map(item => ({
  title: item.displayName ? `${item.displayName} · ${item.id}` : item.id,
  value: item.id
})));
const conflictCount = computed(() => [
  ...endpointAccounts.value,
  ...participants.value,
  ...relationCards.value
].filter(item => item.conflicted).length);
const sortedParticipants = computed(() => [...participants.value].sort((left, right) => {
  if (Boolean(left.conflicted) !== Boolean(right.conflicted)) return left.conflicted ? -1 : 1;
  return right.updatedAt.localeCompare(left.updatedAt);
}));
const sortedAccounts = computed(() => [...endpointAccounts.value].sort((left, right) => {
  if (Boolean(left.conflicted) !== Boolean(right.conflicted)) return left.conflicted ? -1 : 1;
  return right.updatedAt.localeCompare(left.updatedAt);
}));
const sortedRelations = computed(() => [...relationCards.value].sort((left, right) => {
  if (Boolean(left.conflicted) !== Boolean(right.conflicted)) return left.conflicted ? -1 : 1;
  return right.updatedAt.localeCompare(left.updatedAt);
}));

function emptyParticipantForm(): ParticipantForm {
  return { participantId: "", participantKind: "person", displayName: "", aliasesText: "", status: "candidate", evidenceRefs: [], evidenceNote: "" };
}

function emptyAccountForm(): AccountForm {
  return { platform: "", endpointIdentityNamespace: "", senderStableId: "", displayName: "", isSelf: false, participantLinks: [], evidenceNote: "" };
}

function emptyRelationForm(): RelationForm {
  return {
    relationId: "", subjectParticipantId: "", targetKind: "participant", targetId: "", relationship: "",
    status: "candidate", conversationKeysText: "", projectIdsText: "", evidenceRefs: [], evidenceNote: ""
  };
}

function listFromText(value: string): string[] {
  return [...new Set(value.split(/[\n,，]/).map(item => item.trim()).filter(Boolean))];
}

function compactTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().replace("T", " ").slice(0, 16) : value;
}

function statusLabel(value: IdentityRelationStatus): string {
  return ({ candidate: "候选", confirmed: "已确认", corrected: "已纠正", retired: "已停用" })[value];
}

function statusColor(value: IdentityRelationStatus): string | undefined {
  return ({ candidate: "warning", confirmed: "success", corrected: "secondary", retired: undefined })[value];
}

function participantName(id: string): string {
  const participant = participants.value.find(item => item.id === id);
  return participant?.displayName || participant?.id || id;
}

function recordSummary(record: IdentityEndpointAccount | IdentityParticipant | IdentityRelationCard): string {
  if ("platform" in record) return `${record.platform} / ${record.endpointIdentityNamespace} / ${record.senderStableId}`;
  if ("kind" in record) return `${record.displayName || record.id} · ${statusLabel(record.status)}`;
  return `${record.relationship} · ${record.targetKind}:${record.targetId}`;
}

function appendEvidence(existing: IdentityEvidenceRef[], note: string): IdentityEvidenceRef[] {
  const normalized = note.trim();
  return normalized ? [...existing, { note: normalized }] : existing;
}

async function refresh(): Promise<void> {
  if (!props.roleId || loading.value) return;
  loading.value = true;
  error.value = "";
  try {
    const result = await personaIdentityRelationClient.list(props.roleId);
    endpointAccounts.value = result.endpointAccounts;
    participants.value = result.participants;
    relationCards.value = result.relationCards;
    loaded.value = true;
    await refreshSituations();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    loading.value = false;
  }
}

async function refreshSituations(): Promise<void> {
  if (!props.roleId || situationsLoading.value) return;
  situationsLoading.value = true;
  try {
    situations.value = await personaIdentityRelationClient.listSituations(props.roleId);
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    situationsLoading.value = false;
  }
}

function situationTopic(item: ConversationSituationSnapshot): string {
  if (item.topic.projectCandidates.length === 0) return "没有可核对的项目线索";
  return item.topic.projectCandidates.map(project => `${project.status === "confirmed" ? "已确认" : "候选"} ${project.projectId}（${project.relationship}）`).join("；");
}

function openParticipant(item?: IdentityParticipant): void {
  participantEditing.value = Boolean(item);
  participantForm.value = item ? {
    participantId: item.id,
    participantKind: item.kind,
    displayName: item.displayName || "",
    aliasesText: item.aliases.join(", "),
    status: item.status,
    evidenceRefs: item.evidenceRefs,
    evidenceNote: ""
  } : emptyParticipantForm();
  participantDialog.value = true;
}

function openAccount(item?: IdentityEndpointAccount): void {
  accountEditing.value = Boolean(item);
  accountForm.value = item ? {
    platform: item.platform,
    endpointIdentityNamespace: item.endpointIdentityNamespace,
    senderStableId: item.senderStableId,
    displayName: item.displayName || "",
    isSelf: item.isSelf === true,
    participantLinks: item.participantLinks.map(link => ({ ...link, evidenceRefs: [...link.evidenceRefs] })),
    evidenceNote: ""
  } : emptyAccountForm();
  accountDialog.value = true;
}

function openRelation(item?: IdentityRelationCard): void {
  relationEditing.value = Boolean(item);
  relationForm.value = item ? {
    relationId: item.id,
    subjectParticipantId: item.subjectParticipantId,
    targetKind: item.targetKind,
    targetId: item.targetId,
    relationship: item.relationship,
    status: item.status,
    conversationKeysText: item.scope.conversationKeys.join(", "),
    projectIdsText: item.scope.projectIds.join(", "),
    evidenceRefs: item.evidenceRefs,
    evidenceNote: ""
  } : emptyRelationForm();
  relationDialog.value = true;
}

function addAccountLink(): void {
  accountForm.value.participantLinks.push({ participantId: "", status: "candidate", evidenceRefs: [] });
}

function removeAccountLink(index: number): void {
  accountForm.value.participantLinks.splice(index, 1);
}

async function saveParticipant(): Promise<void> {
  if (!props.roleId || saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    await personaIdentityRelationClient.update(props.roleId, {
      kind: "participant",
      participantId: participantForm.value.participantId.trim() || undefined,
      participantKind: participantForm.value.participantKind,
      displayName: participantForm.value.displayName.trim(),
      aliases: listFromText(participantForm.value.aliasesText),
      status: participantForm.value.status,
      evidenceRefs: appendEvidence(participantForm.value.evidenceRefs, participantForm.value.evidenceNote)
    });
    participantDialog.value = false;
    notice.value = "参与者关系已写入当前人格。";
    await refresh();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    saving.value = false;
  }
}

async function saveAccount(): Promise<void> {
  if (!props.roleId || saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    await personaIdentityRelationClient.update(props.roleId, {
      kind: "endpoint_account",
      platform: accountForm.value.platform.trim(),
      endpointIdentityNamespace: accountForm.value.endpointIdentityNamespace.trim(),
      senderStableId: accountForm.value.senderStableId.trim(),
      displayName: accountForm.value.displayName.trim(),
      isSelf: accountForm.value.isSelf,
      participantLinks: accountForm.value.participantLinks.map(link => ({
        ...link,
        confidence: link.confidence == null ? undefined : Number(link.confidence),
        evidenceRefs: appendEvidence(link.evidenceRefs, accountForm.value.evidenceNote)
      }))
    });
    accountDialog.value = false;
    notice.value = "消息端账号映射已写入当前人格。";
    await refresh();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    saving.value = false;
  }
}

async function saveRelation(): Promise<void> {
  if (!props.roleId || saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    await personaIdentityRelationClient.update(props.roleId, {
      kind: "relation_card",
      relationId: relationForm.value.relationId.trim() || undefined,
      subjectParticipantId: relationForm.value.subjectParticipantId,
      targetKind: relationForm.value.targetKind,
      targetId: relationForm.value.targetId.trim(),
      relationship: relationForm.value.relationship.trim(),
      status: relationForm.value.status,
      scope: {
        conversationKeys: listFromText(relationForm.value.conversationKeysText),
        projectIds: listFromText(relationForm.value.projectIdsText)
      },
      evidenceRefs: appendEvidence(relationForm.value.evidenceRefs, relationForm.value.evidenceNote)
    });
    relationDialog.value = false;
    notice.value = "关系卡已写入当前人格。";
    await refresh();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    saving.value = false;
  }
}

watch(() => props.roleId, () => {
  endpointAccounts.value = [];
  participants.value = [];
  relationCards.value = [];
  situations.value = [];
  loaded.value = false;
  error.value = "";
  notice.value = "";
  if (props.roleId) void refresh();
}, { immediate: true });

watch(() => props.version, () => {
  if (props.roleId && loaded.value) void refresh();
});
</script>

<template>
  <v-card class="app-card glass-card section-card">
    <div class="section-title-row">
      <div>
        <div class="section-title">身份关系</div>
        <div class="section-note">记录消息端账号对应谁，以及可核对的长期关系；它不决定项目归属、委托或执行授权。</div>
      </div>
      <div class="d-flex ga-2 flex-wrap">
        <v-chip v-if="conflictCount" color="warning" variant="tonal">{{ conflictCount }} 个同步冲突</v-chip>
        <v-btn size="small" variant="text" prepend-icon="mdi-refresh" :loading="loading" @click="refresh">刷新</v-btn>
      </div>
    </div>

    <v-alert type="info" variant="tonal" density="compact" class="mb-3">
      昵称、群权限、当前 Route 和关键词都不是身份依据。候选关系只用于核对；存在同步冲突时，先比较候选值，再填完整资料保存，系统才会收敛分支。
    </v-alert>
    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3">{{ error }}</v-alert>
    <v-alert v-if="notice" type="success" variant="tonal" density="compact" class="mb-3">{{ notice }}</v-alert>
    <v-progress-linear v-if="loading" indeterminate color="secondary" class="mb-3" />

    <div class="section-title-row compact-row mt-4">
      <div><div class="section-title small-title">最近对话情境</div><div class="section-note">这是对已投递消息的影子判断，供核对，不会自动创建计划、任务或项目记忆。</div></div>
      <v-btn size="small" variant="text" prepend-icon="mdi-refresh" :loading="situationsLoading" @click="refreshSituations">刷新情境</v-btn>
    </div>
    <div v-if="loaded && situations.length === 0" class="empty-state compact-empty"><div><strong>还没有可回看的情境</strong><span>人格收到可定位的消息后，这里会显示不含聊天正文的判断记录。</span></div></div>
    <v-expansion-panels v-else variant="accordion" class="mb-4">
      <v-expansion-panel v-for="item in situations" :key="item.id">
        <v-expansion-panel-title>
          <div class="d-flex ga-2 align-center flex-wrap"><strong>{{ item.topic.kind === 'project_discussion' ? '项目讨论' : '未判定项目' }}</strong><v-chip size="small" color="success" variant="tonal">可参与讨论</v-chip><v-chip size="small" color="warning" variant="tonal">不可管理项目记录</v-chip><span class="section-note">{{ compactTime(item.createdAt) }}</span></div>
        </v-expansion-panel-title>
        <v-expansion-panel-text>
          <div class="section-note" data-no-i18n>会话：{{ item.conversationId || '无稳定会话键' }} · Route：{{ item.routeId }} · 消息：{{ item.messageIds.join('、') || '无稳定消息 ID' }}</div>
          <div class="mt-2"><strong>项目线索：</strong>{{ situationTopic(item) }}</div>
          <div class="mt-2"><strong>当前立场：</strong>{{ item.agentPosition === 'informed_peer' ? '知情同事，可围绕现场给出建议。' : '旁观理解，不把未知话题归入任何项目。' }}</div>
          <div class="mt-2"><strong>限制：</strong>{{ item.decisions.reason }}</div>
          <div v-if="item.evidence.unresolved.length" class="mt-2 text-warning"><strong>待确认：</strong>{{ item.evidence.unresolved.join('；') }}</div>
        </v-expansion-panel-text>
      </v-expansion-panel>
    </v-expansion-panels>

    <div class="section-title-row compact-row mt-4">
      <div><div class="section-title small-title">参与者</div><div class="section-note">人物、组织或自动化主体，可关联多个消息端账号。</div></div>
      <v-btn size="small" color="secondary" variant="tonal" prepend-icon="mdi-account-plus" @click="openParticipant()">新增参与者</v-btn>
    </div>
    <div v-if="loaded && sortedParticipants.length === 0" class="empty-state compact-empty"><div><strong>还没有参与者</strong><span>先建立可核对的参与者，再关联消息端账号。</span></div></div>
    <div v-else class="rule-list">
      <div v-for="item in sortedParticipants" :key="item.id" class="rule-card">
        <div class="d-flex justify-space-between ga-3 align-start flex-wrap">
          <div class="min-w-0">
            <div class="d-flex ga-2 align-center flex-wrap"><strong data-no-i18n>{{ item.displayName || item.id }}</strong><v-chip size="small" :color="item.conflicted ? 'warning' : statusColor(item.status)" variant="tonal">{{ item.conflicted ? '有冲突' : statusLabel(item.status) }}</v-chip></div>
            <div class="section-note mt-1" data-no-i18n>{{ item.kind }}<template v-if="item.aliases.length"> · {{ item.aliases.join('、') }}</template> · 更新于 {{ compactTime(item.updatedAt) }}</div>
            <details v-if="item.conflicted" class="mt-2 text-caption"><summary>查看 {{ item.conflictCandidates?.length || item.conflictEventIds?.length || 0 }} 个冲突候选</summary><div v-for="candidate in item.conflictCandidates" :key="candidate.eventId" class="mt-1" data-no-i18n>{{ candidate.eventId.slice(-8) }} · {{ recordSummary(candidate.record) }}</div></details>
          </div>
          <v-btn size="small" variant="text" @click="openParticipant(item)">编辑</v-btn>
        </div>
      </div>
    </div>

    <div class="section-title-row compact-row mt-5">
      <div><div class="section-title small-title">消息端账号</div><div class="section-note">只按平台、消息端命名空间和稳定发送者 ID 精确匹配。</div></div>
      <v-btn size="small" color="secondary" variant="tonal" prepend-icon="mdi-link-plus" :disabled="participants.length === 0" @click="openAccount()">关联账号</v-btn>
    </div>
    <div v-if="loaded && sortedAccounts.length === 0" class="empty-state compact-empty"><div><strong>还没有账号映射</strong><span>账号建立后，投递上下文才能识别“谁在说话”。</span></div></div>
    <div v-else class="rule-list">
      <div v-for="item in sortedAccounts" :key="item.id" class="rule-card">
        <div class="d-flex justify-space-between ga-3 align-start flex-wrap">
          <div class="min-w-0"><div class="d-flex ga-2 align-center flex-wrap"><strong data-no-i18n>{{ item.displayName || item.senderStableId }}</strong><v-chip size="small" :color="item.conflicted ? 'warning' : undefined" variant="tonal">{{ item.conflicted ? '有冲突' : `${item.participantLinks.length} 个映射` }}</v-chip></div><div class="section-note mt-1" data-no-i18n>{{ item.platform }} / {{ item.endpointIdentityNamespace }} / {{ item.senderStableId }}</div><div class="section-note mt-1"><span v-for="link in item.participantLinks" :key="link.participantId" class="mr-2">{{ participantName(link.participantId) }}（{{ statusLabel(link.status) }}）</span></div><details v-if="item.conflicted" class="mt-2 text-caption"><summary>查看冲突候选</summary><div v-for="candidate in item.conflictCandidates" :key="candidate.eventId" class="mt-1" data-no-i18n>{{ candidate.eventId.slice(-8) }} · {{ recordSummary(candidate.record) }}</div></details></div>
          <v-btn size="small" variant="text" @click="openAccount(item)">编辑</v-btn>
        </div>
      </div>
    </div>

    <div class="section-title-row compact-row mt-5">
      <div><div class="section-title small-title">关系卡</div><div class="section-note">记录范围明确的长期协作或归属线索，不把群聊讨论自动变成当前项目。</div></div>
      <v-btn size="small" color="secondary" variant="tonal" prepend-icon="mdi-account-network" :disabled="participants.length === 0" @click="openRelation()">新增关系</v-btn>
    </div>
    <div v-if="loaded && sortedRelations.length === 0" class="empty-state compact-empty"><div><strong>还没有关系卡</strong><span>需要时再添加，并限定它适用的群或项目。</span></div></div>
    <div v-else class="rule-list">
      <div v-for="item in sortedRelations" :key="item.id" class="rule-card"><div class="d-flex justify-space-between ga-3 align-start flex-wrap"><div class="min-w-0"><div class="d-flex ga-2 align-center flex-wrap"><strong>{{ item.relationship }}</strong><v-chip size="small" :color="item.conflicted ? 'warning' : statusColor(item.status)" variant="tonal">{{ item.conflicted ? '有冲突' : statusLabel(item.status) }}</v-chip></div><div class="section-note mt-1" data-no-i18n>{{ participantName(item.subjectParticipantId) }} → {{ item.targetKind }}:{{ item.targetId }}</div><div class="section-note" data-no-i18n>群 {{ item.scope.conversationKeys.join('、') || '不限' }} · 项目 {{ item.scope.projectIds.join('、') || '不限' }}</div><details v-if="item.conflicted" class="mt-2 text-caption"><summary>查看冲突候选</summary><div v-for="candidate in item.conflictCandidates" :key="candidate.eventId" class="mt-1" data-no-i18n>{{ candidate.eventId.slice(-8) }} · {{ recordSummary(candidate.record) }}</div></details></div><v-btn size="small" variant="text" @click="openRelation(item)">编辑</v-btn></div></div>
    </div>
  </v-card>

  <v-dialog v-model="participantDialog" max-width="640"><v-card class="app-card"><v-card-title>{{ participantEditing ? '编辑参与者' : '新增参与者' }}</v-card-title><v-card-text><div class="form-grid"><v-text-field v-model="participantForm.participantId" label="参与者 ID" :readonly="participantEditing" hint="留空时自动生成；已有 ID 不能改名。" persistent-hint /><v-select v-model="participantForm.participantKind" :items="participantKindOptions" label="类型" /><v-text-field v-model="participantForm.displayName" label="显示名称" /><v-select v-model="participantForm.status" :items="statusOptions" label="状态" /><v-text-field v-model="participantForm.aliasesText" class="full-span" label="别名" hint="用逗号分隔。" persistent-hint /><v-textarea v-model="participantForm.evidenceNote" class="full-span" label="本次核对说明（可选）" rows="2" hint="只写简短可核对依据，不要粘贴私人聊天正文。" persistent-hint /></div></v-card-text><v-card-actions><v-spacer /><v-btn variant="text" @click="participantDialog = false">取消</v-btn><v-btn color="secondary" :loading="saving" @click="saveParticipant">保存</v-btn></v-card-actions></v-card></v-dialog>

  <v-dialog v-model="accountDialog" max-width="760"><v-card class="app-card"><v-card-title>{{ accountEditing ? '编辑账号映射' : '关联消息端账号' }}</v-card-title><v-card-text><v-alert type="warning" variant="tonal" density="compact" class="mb-3">平台、消息端命名空间和稳定发送者 ID 是身份键。它们不能用昵称、Route 或群号替代。</v-alert><div class="form-grid"><v-text-field v-model="accountForm.platform" label="平台" :readonly="accountEditing" placeholder="napcat / feishu / wecom" /><v-text-field v-model="accountForm.endpointIdentityNamespace" label="消息端命名空间" :readonly="accountEditing" placeholder="bot:12345" /><v-text-field v-model="accountForm.senderStableId" label="稳定发送者 ID" :readonly="accountEditing" /><v-text-field v-model="accountForm.displayName" label="消息显示名（可选）" /><v-switch v-model="accountForm.isSelf" label="这是当前人格自身账号" color="success" inset hide-details /></div><div class="section-title-row compact-row mt-5"><div><div class="section-title small-title">参与者映射</div><div class="section-note">确认一个映射不等于确认项目归属或授权。</div></div><v-btn size="small" variant="tonal" prepend-icon="mdi-plus" @click="addAccountLink">添加映射</v-btn></div><div v-for="(link, index) in accountForm.participantLinks" :key="index" class="rule-card mb-2"><div class="form-grid"><v-select v-model="link.participantId" :items="participantOptions" label="参与者" /><v-select v-model="link.status" :items="statusOptions" label="映射状态" /><v-text-field v-model.number="link.confidence" type="number" min="0" max="1" step="0.05" label="置信度（可选）" /><v-btn class="align-self-center" size="small" variant="text" color="error" @click="removeAccountLink(index)">移除</v-btn></div></div><v-textarea v-model="accountForm.evidenceNote" label="本次核对说明（可选）" rows="2" hint="保存时附到本次账号映射的证据中。" persistent-hint /></v-card-text><v-card-actions><v-spacer /><v-btn variant="text" @click="accountDialog = false">取消</v-btn><v-btn color="secondary" :loading="saving" @click="saveAccount">保存</v-btn></v-card-actions></v-card></v-dialog>

  <v-dialog v-model="relationDialog" max-width="760"><v-card class="app-card"><v-card-title>{{ relationEditing ? '编辑关系卡' : '新增关系卡' }}</v-card-title><v-card-text><div class="form-grid"><v-text-field v-model="relationForm.relationId" label="关系卡 ID" :readonly="relationEditing" hint="留空时自动生成。" persistent-hint /><v-select v-model="relationForm.subjectParticipantId" :items="participantOptions" label="主体参与者" /><v-select v-model="relationForm.targetKind" :items="relationTargetOptions" label="关系目标类型" /><v-text-field v-model="relationForm.targetId" label="关系目标 ID" /><v-text-field v-model="relationForm.relationship" label="关系说明" placeholder="例如：参与讨论" /><v-select v-model="relationForm.status" :items="statusOptions" label="状态" /><v-text-field v-model="relationForm.conversationKeysText" class="full-span" label="适用会话（可选）" hint="用逗号分隔 conversationKey；留空表示不按会话限制。" persistent-hint /><v-text-field v-model="relationForm.projectIdsText" class="full-span" label="适用项目（可选）" hint="用逗号分隔项目 ID；留空表示不按项目限制。" persistent-hint /><v-textarea v-model="relationForm.evidenceNote" class="full-span" label="本次核对说明（可选）" rows="2" /></div></v-card-text><v-card-actions><v-spacer /><v-btn variant="text" @click="relationDialog = false">取消</v-btn><v-btn color="secondary" :loading="saving" @click="saveRelation">保存</v-btn></v-card-actions></v-card></v-dialog>
</template>
