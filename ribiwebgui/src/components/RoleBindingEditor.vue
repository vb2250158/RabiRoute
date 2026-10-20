<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useGatewayStore } from "../stores/gatewayStore";
import { roleRequest, type RoleSummary } from "../stores/roleStore";
import { bootstrapRemotePersonaService, remotePersonaClient, remotePersonaServicePath, type PersonaSourceDevice } from "../persona/remotePersonaReference";
const store = useGatewayStore();
const gateway = computed(() => store.selectedGateway);
const catalog = ref<RoleSummary[]>([]);
const devices = ref<PersonaSourceDevice[]>([]);
const error = ref("");
const loading = ref(false);
let version = 0;
const options = computed(() => {
  const items = [{ title: "无角色", value: "", props: { disabled: false } }, ...catalog.value.map(role => ({ title: `${role.title} · ${role.roleId}`, value: role.roleId, props: { disabled: !!role.error } }))];
  const saved = gateway.value?.agentRoleId || "";
  if (saved && !items.some(item => item.value === saved)) items.push({ title: `${saved} · 已保存的引用（已归档或不可用）`, value: saved, props: { disabled: true } });
  return items;
});
async function load() {
  const generation = ++version;
  const source = gateway.value?.agentRoleDeviceId || "";
  loading.value = true; error.value = ""; catalog.value = [];
  try {
    if (source) await bootstrapRemotePersonaService(source);
    let cursor = "";
    const collected: RoleSummary[] = [];
    do {
      const path = `/api/roles?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page = await roleRequest<{ roles: RoleSummary[]; nextCursor: string | null }>(source ? remotePersonaServicePath(source, path) : path);
      if (generation !== version) return;
      collected.push(...page.roles); catalog.value = [...collected]; cursor = page.nextCursor || "";
    } while (cursor);
  } catch (failure) { if (generation === version) error.value = failure instanceof Error ? failure.message : String(failure); }
  finally { if (generation === version) loading.value = false; }
}
function sourceChanged(value: string) {
  store.updateGatewayField("agentRoleDeviceId", value || undefined);
  store.updateGatewayField("agentRoleId", "");
}
watch(() => `${gateway.value?.id}:${gateway.value?.agentRoleDeviceId || ''}`, () => { void load(); }, { immediate: true });
onMounted(() => { void remotePersonaClient.devices().then(result => { devices.value = result; }).catch(() => {}); });
onBeforeUnmount(() => { version++; });
</script>
<template>
  <v-card v-if="gateway" class="app-card glass-card section-card my-4">
    <div class="section-title">关联角色</div>
    <div class="form-grid mt-3">
      <v-select :model-value="gateway.agentRoleDeviceId || ''" :items="[{ title: '本机', value: '' }, ...devices.map(device => ({ title: device.name, value: device.deviceId }))]" label="角色来源 PC" @update:model-value="value => sourceChanged(String(value || ''))" />
      <v-autocomplete :model-value="gateway.agentRoleId || ''" :items="options" label="绑定角色" :loading="loading" :disabled="loading || !!error" @update:model-value="value => store.updateGatewayField('agentRoleId', String(value || ''))" />
      <v-text-field v-if="gateway.agentRoleId" :model-value="gateway.agentRoleFile || 'persona.md'" label="角色文件名" @update:model-value="value => store.updateGatewayField('agentRoleFile', String(value || 'persona.md'))" />
    </div>
    <v-alert v-if="error" type="error">{{ error }}</v-alert>
  </v-card>
</template>
