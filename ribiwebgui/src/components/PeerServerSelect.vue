<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { managerEventSource } from "../managerApi";
import { speechServerOptions } from "../speech/peerServerPresentation";
import type { PeerConnectionStatus, SpeechServerDirectory } from "@shared/peerTunnelContract";
const props = withDefaults(defineProps<{ modelValue?: string; persistSelection?: boolean; label?: string; disabled?: boolean }>(), {
  modelValue: "", persistSelection: false, label: "模型服务电脑", disabled: false
});
const emit = defineEmits<{ changed: [deviceId: string] }>();
const selected = ref(props.modelValue);
const peers = ref<PeerConnectionStatus[]>([]);
const loading = ref(false);
const menuOpen = ref(false);
const saving = ref(false);
const error = ref("");
const now = ref(Date.now());
let events: EventSource | undefined;
let disposed = false;
let requestSequence = 0;
let expiration: ReturnType<typeof setTimeout> | undefined;
const options = computed(() => speechServerOptions(peers.value, selected.value, now.value));
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch("/api/rabilink/peer/" + path, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "无法读取服务电脑"); return body as T;
}
function expireLatency() {
  clearTimeout(expiration); now.value = Date.now();
  const times = peers.value.map(peer => peer.measuredAt === null ? 0 : peer.measuredAt + 30_001).filter(time => time > now.value);
  if (times.length) expiration = setTimeout(expireLatency, Math.min(...times) - now.value);
}
function subscribe() {
  events?.close();
  const ids = peers.value.filter(peer => (menuOpen.value || peer.deviceId === selected.value) && peer.online && peer.supported).slice(0, 10).map(peer => peer.deviceId);

  events = managerEventSource("/api/rabilink/peer/events?ids=" + encodeURIComponent(JSON.stringify(ids)));
  events.addEventListener("selection", () => { if (!disposed) void refresh(false); });
  events.addEventListener("status", event => {
    if (disposed) return;
    const value = JSON.parse((event as MessageEvent).data) as PeerConnectionStatus;
    peers.value = peers.value.map(peer => peer.deviceId === value.deviceId ? value : peer); expireLatency();
  });
}
async function refresh(probe = false) {
  const sequence = ++requestSequence; loading.value = true;
  try {
    const directory = await api<SpeechServerDirectory>("servers");
    if (disposed || sequence !== requestSequence) return;
    const next = props.persistSelection ? directory.selectedDeviceId : props.modelValue;
    const changed = selected.value !== next;
    selected.value = next; peers.value = directory.peers; error.value = ""; expireLatency(); subscribe();
    if (changed && props.persistSelection) emit("changed", selected.value);
    if (probe || selected.value) {
      const ids = peers.value.filter(peer => (probe || peer.deviceId === selected.value) && peer.online && peer.supported).slice(0, 10).map(peer => peer.deviceId);
      if (ids.length) {
        const result = await api<SpeechServerDirectory>("probe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceIds: ids }) });
        if (!disposed && sequence === requestSequence) { peers.value = result.peers; expireLatency(); }
      }
    }
  } catch (cause) { if (!disposed && sequence === requestSequence) error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { if (sequence === requestSequence) loading.value = false; }
}
async function select(value: string) {
  if (props.disabled || saving.value || value === selected.value) return;
  saving.value = true;
  try {
    if (props.persistSelection) await api("selection", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceId: value }) });
    selected.value = value; emit("changed", value); await refresh(true);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { saving.value = false; }
}
function menuChanged(open: boolean) { menuOpen.value = open; if (open) void refresh(true); else subscribe(); }
watch(() => props.modelValue, value => {
  if (props.persistSelection || value === selected.value) return;
  selected.value = value; subscribe();
});
onMounted(() => { void refresh(false); });
onBeforeUnmount(() => { disposed = true; requestSequence++; events?.close(); clearTimeout(expiration); });
</script>

<template>
    <v-select class="peer-server-picker" :model-value="selected" :items="options" :label="label" :aria-label="`选择${label}`"
      density="compact" variant="outlined" :loading="loading || saving" :disabled="disabled || saving" :error="!!error"
      :title="error || options.find(item => item.value === selected)?.detail"
      hide-details @update:model-value="select" @update:menu="menuChanged">
      <template #item="{ props, item }">
        <v-list-item v-bind="props" :subtitle="item.raw.detail" />
      </template>
      <template #selection="{ item }"><span class="text-truncate">{{ item.raw.title }}</span></template>
      <template #append-inner>
        <v-icon v-if="error" icon="mdi-alert-circle-outline" color="warning" :aria-label="error" />
      </template>
      <template #append-item>
        <v-divider />
        <div class="text-caption pa-3">自动选择：局域网 → P2P → 服务器中转。延迟为当前连接的往返时间，不含模型处理耗时。</div>
        <v-alert v-if="error" type="warning" variant="tonal" class="ma-2" role="alert">{{ error }}</v-alert>
      </template>
    </v-select>
</template>
