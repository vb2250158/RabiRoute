<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { agentAdapterManifest, isAgentThreadCapableAdapter, planAssistantAgentTypes } from "@shared/agentAdapterCapabilities";
import { browserUuid } from "../../../../../ribiwebgui/src/browserUuid";
import { useI18n } from "../../../../../ribiwebgui/src/i18n/index";
import { ManagerRequestError, type createRoleKnowledgeClient, type PlanBindingSession } from "../../../../../ribiwebgui/src/roleKnowledgeClient";
import type { RolePlan } from "../../../../../ribiwebgui/src/types";
import { userFacingError } from "../../../../../ribiwebgui/src/userFacingError";

const props = defineProps<{
  roleId: string;
  plan: RolePlan;
  client: ReturnType<typeof createRoleKnowledgeClient>;
}>();
const emit = defineEmits<{ close: []; saved: [plan: RolePlan] }>();
const { t } = useI18n();
const adapters = planAssistantAgentTypes.filter(isAgentThreadCapableAdapter)
  .map(value => ({ value, title: agentAdapterManifest(value).label }));
const revision = ref("");
const previousBinding = ref<RolePlan["taskBinding"]>();
const provider = ref("");
const dshBaseUrl = ref("");
const sessions = ref<PlanBindingSession[]>([]);
const sessionId = ref("");
const nextOffset = ref<number | null>(null);
const loading = ref(true);
const saving = ref(false);
const error = ref("");
let scan: AbortController | undefined;
const opening = new AbortController();
const selected = computed(() => sessions.value.find(session => session.id === sessionId.value));
const canSave = computed(() => Boolean(revision.value && selected.value) && !loading.value && !saving.value);

async function loadSessions(offset = 0) {
  scan?.abort();
  const request = new AbortController();
  scan = request;
  loading.value = true;
  error.value = "";
  if (!offset) {
    sessions.value = [];
    sessionId.value = "";
    nextOffset.value = null;
  }
  try {
    const page = await props.client.listPlanBindingSessions(provider.value, offset,
      provider.value === "dsh" ? dshBaseUrl.value.trim() || undefined : undefined, request.signal);
    if (request.signal.aborted) return;
    const unique = new Map(sessions.value.map(session => [session.id, session]));
    for (const session of page.threads) {
      if (session.id && session.cwd?.trim() && !session.archived) unique.set(session.id, session);
    }
    sessions.value = [...unique.values()];
    nextOffset.value = page.nextOffset;
  } catch (cause) {
    if (!request.signal.aborted) error.value = userFacingError(cause);
  } finally {
    if (!request.signal.aborted) loading.value = false;
  }
}

async function loadCurrentBinding() {
  try {
    const snapshot = await props.client.loadPlanBindingRevision(props.roleId, props.plan.id, opening.signal);
    if (opening.signal.aborted) return;
    revision.value = snapshot.etag;
    previousBinding.value = snapshot.binding;
    dshBaseUrl.value = snapshot.binding?.baseUrl || "";
    provider.value = adapters.find(adapter => adapter.value === snapshot.binding?.agentType)?.value || "";
    if (!provider.value) loading.value = false;
  } catch (cause) {
    if (!opening.signal.aborted) {
      error.value = userFacingError(cause);
      loading.value = false;
    }
  }
}

watch(provider, value => { if (value) void loadSessions(); });
void loadCurrentBinding();
onBeforeUnmount(() => { opening.abort(); scan?.abort(); });

async function save() {
  if (!canSave.value) return;
  saving.value = true;
  error.value = "";
  try {
    const plan = await props.client.replacePlanBinding({
      roleId: props.roleId, planId: props.plan.id, agentAdapter: provider.value, sessionId: sessionId.value,
      dshBaseUrl: provider.value === "dsh" ? dshBaseUrl.value.trim() || undefined : undefined,
      previousBinding: previousBinding.value, expectedRevision: revision.value, requestId: `plan-bind:${browserUuid()}`
    });
    emit("saved", plan);
  } catch (cause) {
    // A lost response or stale revision needs fresh plan state before another write.
    if (!(cause instanceof ManagerRequestError) || cause.status === 0 || cause.status === 409
      || cause.status === 412 || cause.status >= 500) revision.value = "";
    error.value = userFacingError(cause);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <v-dialog :model-value="true" :persistent="saving" max-width="620" @update:model-value="value => { if (!value && !saving) emit('close'); }">
    <v-card :title="t('更换计划执行会话')" :subtitle="plan.title">
      <v-card-text>
        <p v-if="previousBinding" class="mb-4">
          {{ t('当前执行会话') }} · {{ agentAdapterManifest(previousBinding.agentType).label }} ·
          {{ previousBinding.sessionTitle || previousBinding.sessionId }}
        </p>
        <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-4">{{ error }}</v-alert>
        <v-select v-model="provider" :items="adapters" :label="t('Agent 端')" :disabled="!revision || saving" />
        <v-text-field
          v-if="provider === 'dsh' && previousBinding?.baseUrl"
          :model-value="dshBaseUrl" :label="t('DSH 会话服务地址')" readonly
        />
        <v-autocomplete
          v-model="sessionId" :items="sessions" item-value="id" :label="t('执行会话')"
          :item-title="session => [session.title || session.id, session.cwd, session.updatedAt && new Date(session.updatedAt).toLocaleString()].filter(Boolean).join(' · ')"
          :loading="loading" :disabled="!revision || saving"
        />
        <v-btn v-if="nextOffset !== null" variant="text" :disabled="loading || saving" @click="loadSessions(nextOffset)">
          {{ t('加载更多会话') }}
        </v-btn>
        <v-btn variant="text" prepend-icon="mdi-refresh" :disabled="!provider || !revision || loading || saving" @click="loadSessions()">
          {{ t('刷新会话') }}
        </v-btn>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn :disabled="saving" @click="emit('close')">{{ t('取消') }}</v-btn>
        <v-btn color="primary" :loading="saving" :disabled="!canSave" @click="save">{{ t('保存绑定') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
