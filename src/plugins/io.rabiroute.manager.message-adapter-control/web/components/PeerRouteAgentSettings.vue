<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import type { RemoteAgentTarget, AgentTargetSession } from "@shared/routeAgentTargets";
import type { InstanceAgent } from "@shared/agentInstance";
import { postRouteAgentThreadAction } from "../../../../../ribiwebgui/src/routeAgentThreadClient";
import { managerAccessToken } from "../../../../../ribiwebgui/src/managerApi";
import { userFacingError } from "../../../../../ribiwebgui/src/userFacingError";

const props = defineProps<{ target: RemoteAgentTarget; agent?: InstanceAgent; connected: boolean }>();
const emit = defineEmits<{ selected: [session: AgentTargetSession] }>();
type Session = { id: string; title: string; cwd?: string; archived?: boolean };
const sessions = ref<Session[]>([]), selectedId = ref("");
const busy = ref(false), error = ref("");
let revision = 0, disposed = false;
watch(() => props.target, target => {
  revision++; busy.value = false; error.value = "";
  selectedId.value = target.sessionId || props.agent?.sessionId || "";
}, { immediate: true });
const binding = () => ({ id: props.target.id, provider: props.target.provider, binding: {
  ownerDeviceId: props.target.ownerDeviceId, instanceId: props.target.instanceId, agentId: props.target.agentId } });
async function refresh(): Promise<void> {
  const current = ++revision, target = binding(); busy.value = true; error.value = "";
  try {
    const result = await postRouteAgentThreadAction({ action: "list", limit: 100 }, target, { accessToken: managerAccessToken });
    if (!disposed && current === revision) sessions.value = Array.isArray(result.threads) ? result.threads : [];
  } catch (reason) { if (!disposed && current === revision) error.value = userFacingError(reason); }
  finally { if (!disposed && current === revision) busy.value = false; }
}
async function select(): Promise<void> {
  const current = ++revision, target = binding(), threadId = selectedId.value.trim();
  if (!threadId) return;
  busy.value = true; error.value = "";
  try {
    const result = await postRouteAgentThreadAction({ action: "read", threadId }, target, { accessToken: managerAccessToken });
    if (disposed || current !== revision) return;
    const thread = result.thread as Session | undefined;
    if (!thread || thread.id !== threadId) throw new Error("未取得所选完整会话，请刷新会话后重试。");
    if (thread.archived) throw new Error("此会话已归档，请先在原宿主恢复会话，或选择另一个未归档会话。");
    emit("selected", { sessionId: thread.id, sessionName: thread.title, workspace: thread.cwd || "" });
  } catch (reason) { if (!disposed && current === revision) error.value = userFacingError(reason); }
  finally { if (!disposed && current === revision) busy.value = false; }
}
onBeforeUnmount(() => { disposed = true; revision++; });
</script>

<template>
  <div>
    <p class="text-body-2 mb-3">选择这台电脑上的真实会话，引用随当前路线保存。</p>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-3">{{ error }}</v-alert>
    <v-combobox v-model="selectedId" :items="sessions.map(session => ({ title: `${session.title} · ${session.id}`, value: session.id }))" :return-object="false" label="远端完整会话 ID" :disabled="busy" />
    <p v-if="target.sessionId" class="text-caption mb-2">当前引用：{{ target.sessionName || target.sessionId }} · {{ target.workspace }}</p>
    <v-btn :disabled="!connected || busy" :loading="busy" @click="refresh">刷新真实会话</v-btn>
    <v-btn class="ml-2" color="primary" :disabled="!connected || busy || !selectedId.trim()" @click="select">用于当前路线</v-btn>
  </div>
</template>
