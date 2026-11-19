<script setup lang="ts">
import { userFacingError } from "../../../../../ribiwebgui/src/userFacingError";
import { onBeforeUnmount, ref, watch } from "vue";
import type { PlanFollowupRule } from "@shared/planFollowup";
import { usePersonaService } from "../persona/personaServiceClient";

const props = defineProps<{ rule: PlanFollowupRule; roleId: string }>();
const emit = defineEmits<{ "update:rule": [value: PlanFollowupRule] }>();
const { fetch } = usePersonaService();
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
function change(patch: Partial<PlanFollowupRule>) { emit("update:rule", { ...props.rule, ...patch }); }
</script>

<template>
  <div>
    <p class="section-note mb-3">计划任务结束后，按标记状态匹配第一条规则。</p>
    <v-alert v-if="error" type="warning" variant="tonal" density="compact" class="mb-4">
      {{ error }}
      <v-btn variant="text" size="small" :loading="loading" @click="loadStatuses">重新读取</v-btn>
    </v-alert>
    <v-select :model-value="rule.statusKeys" :items="statuses" label="触发的标记状态" multiple chips
      :disabled="loading || Boolean(error)" :loading="loading"
      :error-messages="!loading && !error && rule.statusKeys.some(key => !statuses.some(item => item.value === key)) ? '部分状态已移除，请重新选择' : []"
      @update:model-value="value => change({ statusKeys: value })" />
    <v-textarea :model-value="rule.prompt" label="追问内容" rows="3" maxlength="4000" counter
      placeholder="例如：核对当前步骤是否还有已授权且可独立完成的事项。有则继续，没有则记录原因。"
      @update:model-value="value => change({ prompt: value })" />
    <p v-if="!rule.prompt.trim() || !rule.statusKeys.length" class="section-note">选择状态并填写内容后，这条规则才会生效。</p>
  </div>
</template>
