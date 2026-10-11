<script setup lang="ts">
import { browserUuid } from "../browserUuid";
import { userFacingError } from "../userFacingError";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { normalizePlanFollowup, type PlanFollowupSettings, type PlanFollowupRule } from "@shared/planFollowup";
const props = defineProps<{ modelValue?: PlanFollowupSettings; roleId: string }>();
const emit = defineEmits<{ "update:modelValue": [value: PlanFollowupSettings] }>();
// Preserve the user's draft, including spaces while typing; normalize at persistence/runtime boundaries.
const settings = computed(() => props.modelValue ?? normalizePlanFollowup(undefined));
const statuses = ref<{ title: string; value: string }[]>([]);
const error = ref("");
const loading = ref(false);
let controller: AbortController | undefined;
async function loadStatuses() {
  controller?.abort();
  const request = new AbortController(); controller = request;
  const roleId = props.roleId;
  statuses.value = []; error.value = "";
  if (!roleId) { loading.value = false; return; }
  loading.value = true;
  try {
    const response = await fetch(`/api/roles/${encodeURIComponent(roleId)}/plan-marker-statuses`, { signal: request.signal });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || "读取标记状态失败");
    statuses.value = result.data.statuses.filter((item: { state: string; terminal: boolean }) => item.state === "enabled" && !item.terminal)
      .map((item: { key: string; label: string }) => ({ title: item.label, value: item.key }));
  } catch (cause) {
    if (!request.signal.aborted) error.value = /failed to fetch|fetch failed|load failed|networkerror|network request failed/i.test(String(cause))
      ? "计划标记状态读取失败，请检查网络和服务状态后重新读取。" : userFacingError(cause);
  } finally { if (controller === request) loading.value = false; }
}
watch(() => props.roleId, loadStatuses, { immediate: true });
onBeforeUnmount(() => controller?.abort());
function update(patch: Partial<PlanFollowupSettings>) { emit("update:modelValue", { ...settings.value, ...patch }); }
function change(rule: PlanFollowupRule, patch: Partial<PlanFollowupRule>) {
  update({ rules: settings.value.rules.map(item => item.id === rule.id ? { ...item, ...patch } : item) });
}
function add() {
  update({ rules: [...settings.value.rules, { id: browserUuid(), enabled: true, statusKeys: [], prompt: "" }] });
}
</script>

<template>
  <div class="dependency-panel followup-settings">
    <div class="followup-heading">
      <div><div class="section-title small-title">自动追问</div>
        <div class="section-note">计划任务结束后，按标记状态匹配第一条规则。</div></div>
      <v-switch :model-value="settings.enabled" aria-label="启用自动追问" color="primary" density="compact" inset hide-details
        @update:model-value="value => update({ enabled: value === true })" />
    </div>
    <v-alert v-if="error" type="warning" variant="tonal" density="compact" class="my-4">
      {{ error }}
      <v-btn variant="text" size="small" :loading="loading" @click="loadStatuses">重新读取</v-btn>
    </v-alert>
    <template v-if="settings.enabled">
    <v-text-field :model-value="settings.cooldownSeconds" class="mt-5 followup-cooldown" label="追问间隔（秒）" type="number" min="0" max="86400" density="compact"
      @update:model-value="value => update({ cooldownSeconds: Number(value) })" />
    <div class="section-note">同一轮最多追问一次；计划步骤、下一动作和规则均无变化时不重复追问。冷却时间不会自动唤醒任务。</div>
    <v-card v-for="rule in settings.rules" :key="rule.id" variant="outlined" class="pa-3 mt-3">
      <v-switch :model-value="rule.enabled" label="启用这条规则" color="primary" hide-details
        @update:model-value="value => change(rule, { enabled: value === true })" />
      <v-select :model-value="rule.statusKeys" :items="statuses" label="触发的标记状态" multiple chips
        :disabled="loading || Boolean(error)" :loading="loading"
        :error-messages="!loading && !error && rule.statusKeys.some(key => !statuses.some(item => item.value === key)) ? '部分状态已移除，请重新选择' : []"
        @update:model-value="value => change(rule, { statusKeys: value })" />
      <v-textarea :model-value="rule.prompt" label="追问内容" rows="3" maxlength="4000" counter
        placeholder="例如：核对当前步骤是否还有已授权且可独立完成的事项。有则继续，没有则记录原因。"
        @update:model-value="value => change(rule, { prompt: value })" />
      <div v-if="!rule.prompt.trim() || !rule.statusKeys.length" class="section-note">选择状态并填写内容后，这条规则才会生效。</div>
      <v-btn variant="text" color="error" @click="update({ rules: settings.rules.filter(item => item.id !== rule.id) })">删除规则</v-btn>
    </v-card>
    <v-btn class="mt-3" variant="tonal" prepend-icon="mdi-plus" @click="add">添加追问规则</v-btn>
    </template>
  </div>
</template>

<style scoped>
.followup-heading { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
.followup-settings .section-note { font-weight: 400; }
.followup-cooldown { max-width: 320px; }
</style>
