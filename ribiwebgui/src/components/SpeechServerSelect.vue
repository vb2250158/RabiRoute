<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { managerEventSource } from "../managerApi";
import { peerServerDetail } from "../speech/peerServerPresentation";
import type { PeerConnectionStatus, SpeechServerDirectory } from "@shared/peerTunnelContract";
const emit = defineEmits<{ changed: [deviceId: string] }>();
const selected = ref("");
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
const options = computed(() => {
  const values = peers.value.map(peer => ({ title: peer.name, value: peer.deviceId,
    detail: peerServerDetail(peer, now.value), props: { disabled: !peer.online || !peer.supported || !peer.trusted } }));
  if (selected.value && !values.some(item => item.value === selected.value)) values.push({ title: selected.value, value: selected.value, detail: "未发现设备", props: { disabled: true } });
  return [{ title: "本机", value: "", detail: "本机调用", props: { disabled: false } }, ...values];
});
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch("/api/rabilink/peer/" + path, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "无法读取语音服务器"); return body as T;
}
function expireLatency() {
  clearTimeout(expiration); now.value = Date.now();
  const times = peers.value.map(peer => peer.measuredAt === null ? 0 : peer.measuredAt + 30_001).filter(time => time > now.value);
  if (times.length) expiration = setTimeout(expireLatency, Math.min(...times) - now.value);
}
function subscribe() {
  events?.close();
  const ids = peers.value.filter(peer => (menuOpen.value || peer.deviceId === selected.value) && peer.online && peer.supported && peer.trusted).slice(0, 10).map(peer => peer.deviceId);

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
    const changed = selected.value !== directory.selectedDeviceId;
    selected.value = directory.selectedDeviceId; peers.value = directory.peers; error.value = ""; expireLatency(); subscribe();
    if (changed) emit("changed", selected.value);
    if (probe || selected.value) {
      const ids = peers.value.filter(peer => (probe || peer.deviceId === selected.value) && peer.online && peer.supported && peer.trusted).slice(0, 10).map(peer => peer.deviceId);
      if (ids.length) {
        const result = await api<SpeechServerDirectory>("probe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceIds: ids }) });
        if (!disposed && sequence === requestSequence) { peers.value = result.peers; expireLatency(); }
      }
    }
  } catch (cause) { if (!disposed && sequence === requestSequence) error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { if (sequence === requestSequence) loading.value = false; }
}
async function select(value: string) {
  if (saving.value || value === selected.value) return;
  saving.value = true;
  try {
    await api("selection", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceId: value }) });
    selected.value = value; emit("changed", value); await refresh(true);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { saving.value = false; }
}
function menuChanged(open: boolean) { menuOpen.value = open; if (open) void refresh(true); else subscribe(); }
onMounted(() => { void refresh(false); });
onBeforeUnmount(() => { disposed = true; requestSequence++; events?.close(); clearTimeout(expiration); });
</script>

<template>
  <v-card class="app-card mb-4 pa-4">
    <v-select :model-value="selected" :items="options" label="语音服务器" :loading="loading || saving" :disabled="saving"
      hide-details="auto" @update:model-value="select" @update:menu="menuChanged">
      <template #item="{ props, item }">
        <v-list-item v-bind="props" :subtitle="item.raw.detail" />
      </template>
      <template #selection="{ item }">{{ item.raw.title }} · {{ item.raw.detail }}</template>
    </v-select>
    <div class="text-caption mt-2">自动选择：局域网 → P2P → 服务器中转。延迟为当前连接的往返时间，不含语音处理耗时。</div>
    <v-alert v-if="error" type="warning" variant="tonal" class="mt-2">{{ error }}</v-alert>
  </v-card>
</template>
