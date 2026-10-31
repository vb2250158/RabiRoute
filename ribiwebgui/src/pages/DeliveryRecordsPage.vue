<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { AgentDeliveryRecord, AgentDeliveryRecordPage } from "@shared/agentDeliveryRecord";
import type { AgentInstance } from "@shared/agentInstance";
import { useI18n } from "../i18n";
import { userFacingError } from "../userFacingError";
import { readDeliveryComputers, readDeliveryRecord, readDeliveryRecords } from "../deliveries/deliveryRecordClient";
import { deliveryRecordCopy, deliveryStateLabels } from "../deliveries/deliveryRecordCopy";
import { deliveryComputerOptions, deliveryEndpointLabel, deliveryStatePresentation, deliveryTimeLabel } from "../deliveries/deliveryRecordPresentation";

const { locale } = useI18n();
const props = defineProps<{ nodeId?: string }>();
const route = useRoute();
const router = useRouter();
const selectedNodeId = computed(() => props.nodeId || (typeof route.query.nodeId === "string" ? route.query.nodeId : ""));
const copy = computed(() => deliveryRecordCopy(locale.value));
const page = ref<AgentDeliveryRecordPage>();
const records = ref<AgentDeliveryRecord[]>([]);
const query = ref("");
const state = ref("");
const loading = ref(false);
const error = ref("");
const detail = ref<AgentDeliveryRecord>();
const detailOpen = ref(false);
const detailLoading = ref(false);
const detailError = ref("");
const copyStatus = ref("");
const computers = ref<AgentInstance[]>([]);
const computersLoading = ref(false);
const computersError = ref("");
let computersAbort: AbortController | undefined;
let listAbort: AbortController | undefined;
let detailAbort: AbortController | undefined;
let applied = { query: "", state: "" };
const stateOptions = computed(() => [
  { title: copy.value.allStates, value: "" },
  ...Object.entries(deliveryStateLabels[locale.value]).filter(([value]) => value !== "local_accepted").map(([value, title]) => ({ title, value }))
]);
const receipt = computed(() => detail.value?.receipt ? JSON.stringify(detail.value.receipt, null, 2) : "");
const coverageText = computed(() => page.value?.coverage.message || (selectedNodeId.value ? copy.value.nodeCoverage : copy.value.coverage));
const status = (value: string) => deliveryStatePresentation(value, locale.value);
const endpoint = (value: AgentDeliveryRecord["source"]) => deliveryEndpointLabel(value, locale.value);
const time = (value?: string) => deliveryTimeLabel(value, locale.value);
const computerOptions = computed(() => deliveryComputerOptions(computers.value, locale.value, selectedNodeId.value));

async function loadComputers(): Promise<void> {
  computersAbort?.abort();
  const controller = new AbortController();
  computersAbort = controller;
  computersLoading.value = true;
  computersError.value = "";
  try {
    const next = await readDeliveryComputers(controller.signal);
    if (!controller.signal.aborted) computers.value = next;
  }
  catch (cause) { if (!controller.signal.aborted) computersError.value = userFacingError(cause); }
  finally { if (computersAbort === controller) computersLoading.value = false; }
}

function selectComputer(nodeId: string): void {
  void router.replace({ query: { ...route.query, nodeId: nodeId || undefined } });
}

function refresh(): void {
  void loadComputers();
  void load();
}

async function load(more = false): Promise<void> {
  listAbort?.abort();
  const controller = new AbortController();
  listAbort = controller;
  loading.value = true;
  error.value = "";
  const requested = more ? applied : { query: String(query.value || "").trim(), state: state.value };
  try {
    const next = await readDeliveryRecords({ ...requested, nodeId: selectedNodeId.value || undefined, cursor: more ? page.value?.nextCursor : undefined }, controller.signal);
    if (controller.signal.aborted) return;
    applied = requested;
    records.value = more ? [...records.value, ...next.records] : next.records;
    page.value = next;
  } catch (cause) {
    if (!controller.signal.aborted) error.value = userFacingError(cause) || copy.value.loadFailed;
  } finally {
    if (listAbort === controller) loading.value = false;
  }
}

async function showDetails(record: AgentDeliveryRecord): Promise<void> {
  detailAbort?.abort();
  const controller = new AbortController();
  detailAbort = controller;
  detailOpen.value = true;
  detail.value = undefined;
  detailError.value = "";
  copyStatus.value = "";
  detailLoading.value = true;
  try {
    const next = await readDeliveryRecord(record.deliveryId, controller.signal, fetch, selectedNodeId.value || undefined);
    if (!controller.signal.aborted) detail.value = next;
  } catch (cause) {
    if (!controller.signal.aborted) detailError.value = userFacingError(cause);
  } finally {
    if (detailAbort === controller) detailLoading.value = false;
  }
}

async function copyId(): Promise<void> {
  if (!detail.value) return;
  try { await navigator.clipboard.writeText(detail.value.deliveryId); copyStatus.value = copy.value.copied; }
  catch { copyStatus.value = copy.value.copyFailed; }
}

watch(selectedNodeId, () => {
  detailAbort?.abort();
  detailOpen.value = false;
  records.value = [];
  page.value = undefined;
  void load();
}, { immediate: true });
onMounted(() => { void loadComputers(); });
onBeforeUnmount(() => { listAbort?.abort(); detailAbort?.abort(); computersAbort?.abort(); });
</script>

<template>
  <section class="delivery-records-page">
    <header class="delivery-header">
      <div><h1>{{ copy.title }}</h1><p>{{ copy.intro }}</p></div>
      <v-btn prepend-icon="mdi-refresh" variant="tonal" :loading="loading" @click="refresh">{{ copy.refresh }}</v-btn>
    </header>
    <v-alert type="info" variant="tonal" class="mb-4">{{ coverageText }}</v-alert>
    <v-select :model-value="selectedNodeId" :label="copy.computer" :items="computerOptions" :loading="computersLoading" :disabled="Boolean(props.nodeId)" class="delivery-computer mb-4" hide-details @update:model-value="value => selectComputer(String(value || ''))" />
    <v-alert v-if="computersError" type="warning" variant="tonal" class="mb-4">{{ copy.computerReadFailed }} {{ computersError }}</v-alert>
    <v-card class="app-card pa-4">
      <form class="delivery-filters" @submit.prevent="load()">
        <v-text-field v-model="query" :label="copy.search" prepend-inner-icon="mdi-magnify" hide-details clearable @click:clear="query = ''" />
        <v-select v-model="state" :label="copy.state" :items="stateOptions" hide-details />
        <v-btn type="submit" variant="tonal" :disabled="loading">{{ copy.apply }}</v-btn>
      </form>
      <div class="delivery-read-time" aria-live="polite">
        <span v-if="page">{{ copy.observedAt }}: {{ time(page.observedAt) }} · {{ records.length }} {{ copy.records }}</span>
        <span>{{ copy.refreshNote }}</span>
      </div>
      <v-alert v-if="error" type="error" variant="tonal" class="my-3" role="alert"><p v-if="selectedNodeId">{{ copy.unavailable }}</p>{{ error }}</v-alert>
      <p v-if="loading && !page" role="status">{{ copy.loading }}</p>
      <p v-else-if="page && !records.length && !error" class="delivery-empty">{{ copy.empty }}</p>
      <ul v-if="records.length" class="delivery-list" :aria-label="copy.title">
        <li v-for="record in records" :key="record.id" class="delivery-item">
          <div class="delivery-item-top">
            <v-chip :color="status(record.state).color" size="small" variant="tonal">{{ status(record.state).label }}</v-chip>
            <time>{{ time(record.updatedAt || record.createdAt) }}</time>
            <v-btn size="small" variant="text" @click="showDetails(record)">{{ copy.details }}</v-btn>
          </div>
          <dl class="delivery-route">
            <dt>{{ copy.source }}</dt><dd data-no-i18n>{{ endpoint(record.source) }}</dd>
            <dt>{{ copy.target }}</dt><dd data-no-i18n>{{ endpoint(record.target) }}</dd>
          </dl>
          <p v-if="record.reason" class="delivery-reason">{{ record.reason }}</p>
          <small class="delivery-id" data-no-i18n>{{ record.deliveryId }}</small>
        </li>
      </ul>
      <v-btn v-if="page?.nextCursor" class="mt-4" block variant="tonal" :loading="loading" @click="load(true)">{{ copy.loadMore }}</v-btn>
    </v-card>
    <v-dialog v-model="detailOpen" max-width="850" @update:model-value="value => { if (!value) detailAbort?.abort(); }">
      <v-card>
        <v-card-title class="d-flex align-center justify-space-between"><span>{{ copy.detailsTitle }}</span><v-btn icon="mdi-close" variant="text" :aria-label="copy.close" @click="detailOpen = false" /></v-card-title>
        <v-card-text>
          <p v-if="detailLoading" role="status">{{ copy.detailLoading }}</p>
          <v-alert v-if="detailError" type="error" variant="tonal" role="alert">{{ detailError }}</v-alert>
          <template v-if="detail">
            <v-chip :color="status(detail.state).color" variant="tonal" class="mb-3">{{ status(detail.state).label }}</v-chip>
            <v-alert v-if="detail.state === 'received'" type="success" variant="tonal" class="mb-3">{{ copy.receivedNote }}</v-alert>
            <dl class="delivery-detail-fields">
              <dt>{{ copy.deliveryId }}</dt><dd data-no-i18n>{{ detail.deliveryId }} <v-btn size="x-small" variant="text" icon="mdi-content-copy" :aria-label="copy.copyId" @click="copyId" /></dd>
              <dt v-if="detail.intentId">{{ copy.intentId }}</dt><dd v-if="detail.intentId" data-no-i18n>{{ detail.intentId }}</dd>
              <dt>{{ copy.owner }}</dt><dd>{{ detail.ownerScope === 'node' ? copy.node : copy.manager }}</dd>
              <dt>{{ copy.source }}</dt><dd data-no-i18n>{{ endpoint(detail.source) }}</dd>
              <dt>{{ copy.target }}</dt><dd data-no-i18n>{{ endpoint(detail.target) }}</dd>
              <dt>{{ copy.created }}</dt><dd>{{ time(detail.createdAt) }}</dd>
              <dt>{{ copy.updated }}</dt><dd>{{ time(detail.updatedAt) }}</dd>
              <dt>{{ copy.attempts }}</dt><dd>{{ detail.attemptCount ?? copy.unknown }}</dd>
              <dt>{{ copy.lastAttempt }}</dt><dd>{{ time(detail.lastAttemptAt) }}</dd>
              <dt>{{ copy.nextAttempt }}</dt><dd>{{ time(detail.nextAttemptAt) }}</dd>
              <dt>{{ copy.receivedAt }}</dt><dd>{{ time(detail.targetAcceptedAt) }}</dd>
              <dt v-if="detail.reason">{{ copy.reason }}</dt><dd v-if="detail.reason">{{ detail.reason }}</dd>
              <dt v-if="detail.errorCode">{{ copy.errorCode }}</dt><dd v-if="detail.errorCode" data-no-i18n>{{ detail.errorCode }}</dd>
            </dl>
            <p v-if="copyStatus" role="status">{{ copyStatus }}</p>
            <details v-if="receipt" class="mt-4"><summary>{{ copy.receipt }}</summary><p>{{ copy.receiptNote }}</p><pre class="delivery-receipt" data-no-i18n>{{ receipt }}</pre></details>
          </template>
        </v-card-text>
      </v-card>
    </v-dialog>
  </section>
</template>

<style scoped>
.delivery-records-page { max-width: 1200px; margin: 0 auto; }
.delivery-header, .delivery-item-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.delivery-header { margin-bottom: 18px; }
.delivery-computer { max-width: 440px; }
.delivery-header h1 { font-size: 1.5rem; margin: 0 0 6px; }
.delivery-header p { margin: 0; color: rgb(var(--v-theme-on-surface), .72); }
.delivery-filters { display: grid; grid-template-columns: minmax(220px, 1fr) 210px auto; align-items: center; gap: 12px; }
.delivery-read-time { display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; font-size: .78rem; opacity: .72; margin: 14px 0; }
.delivery-list { padding: 0; list-style: none; }
.delivery-item { padding: 16px 0; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.delivery-item-top time { margin-left: auto; font-size: .8rem; opacity: .7; }
.delivery-route, .delivery-detail-fields { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px 16px; margin: 12px 0; }
.delivery-route dt, .delivery-detail-fields dt { opacity: .72; }
.delivery-route dd, .delivery-detail-fields dd { margin: 0; overflow-wrap: anywhere; }
.delivery-id { display: block; overflow-wrap: anywhere; opacity: .6; }
.delivery-reason { margin: 8px 0; overflow-wrap: anywhere; }
.delivery-receipt { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 12px; font-size: .8rem; }
.delivery-empty { padding: 28px 0; text-align: center; opacity: .7; }
@media (max-width: 680px) { .delivery-filters { grid-template-columns: 1fr; } .delivery-route, .delivery-detail-fields { grid-template-columns: 1fr; gap: 3px; } .delivery-route dd, .delivery-detail-fields dd { margin-bottom: 9px; } }
</style>
