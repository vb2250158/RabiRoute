<script setup lang="ts" generic="T extends ModelLibraryRow">
import { ref, shallowRef } from "vue";
import ModelUsage from "./ModelUsage.vue";
import { useI18n } from "../i18n/index";
import type { ModelLibraryRow, ModelLibraryCapability, ModelLibraryLabels } from "./modelLibraryPresentation";

defineProps<{
  rows: readonly T[];
  labels: ModelLibraryLabels;
  loading?: boolean;
  usageKind?: string;
  deviceId?: string;
}>();
defineSlots<{ action(props: { row: T }): unknown }>();

const { isEnglish } = useI18n();
const open = ref(false);
const selectedModel = shallowRef<ModelLibraryRow>();
const usageOpen = ref(false);
const selected = shallowRef<{ model: string; sourceUrl?: string; ability: ModelLibraryCapability }>();
let trigger: HTMLElement | null = null;

function showAbility(row: ModelLibraryRow, ability: ModelLibraryCapability, event: Event) {
  trigger = event.currentTarget as HTMLElement;
  selected.value = { model: row.name, sourceUrl: ability.sourceUrl ?? row.sourceUrl, ability };
  open.value = true;
}

function showUsage(row: ModelLibraryRow, event: Event) {
  trigger = event.currentTarget as HTMLElement;
  selectedModel.value = row;
  usageOpen.value = true;
}

function restoreFocus() {
  trigger?.focus();
  trigger = null;
  selected.value = undefined;
  selectedModel.value = undefined;
}
</script>

<template>
  <div v-if="rows.length" class="model-table-shell" tabindex="0" role="region" :aria-label="labels.modelLibrary">
    <table class="model-table">
      <thead>
        <tr>
          <th scope="col" class="model-column">{{ labels.model }}</th>
          <th scope="col" class="capability-column">{{ labels.capability }}</th>
          <th scope="col" class="size-column">{{ labels.size }}</th>
          <th scope="col" class="runtime-column">{{ labels.runtime }}</th>
          <th scope="col" class="source-column">{{ labels.source }}</th>
          <th scope="col" class="action-column">{{ labels.action }}</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="row in rows" :key="row.id">
          <tr class="model-row">
            <td><div class="model-table-name"><button v-if="usageKind" type="button" class="model-name-button" aria-haspopup="dialog" @click="showUsage(row, $event)">{{ row.name }}</button><strong v-else>{{ row.name }}</strong><code>{{ row.id }}</code></div></td>
            <td>
              <div class="model-table-abilities">
                <v-chip v-for="ability in row.abilities" :key="ability.id" tag="button" type="button" size="small" variant="tonal"
                  :prepend-icon="ability.icon" aria-haspopup="dialog" @click="showAbility(row, ability, $event)">
                  {{ ability.label }}
                </v-chip>
              </div>
            </td>
            <td class="model-table-size">{{ row.size }}</td>
            <td><v-icon size="16" class="mr-1">{{ row.runtimeIcon }}</v-icon>{{ row.runtime }}</td>
            <td><v-btn v-if="row.sourceUrl" variant="text" size="small" append-icon="mdi-open-in-new"
              :href="row.sourceUrl" target="_blank" rel="noreferrer">{{ labels.source }}</v-btn></td>
            <td><slot name="action" :row="row" /></td>
          </tr>
          <tr v-if="row.error"><td colspan="6"><v-alert type="error" density="compact" variant="tonal">{{ row.error }}</v-alert></td></tr>
        </template>
      </tbody>
    </table>
  </div>
  <v-empty-state v-else-if="!loading" icon="mdi-cube-off-outline" :title="labels.empty" />

  <v-dialog v-model="usageOpen" max-width="560" :aria-label="selectedModel?.name" @after-leave="restoreFocus">
    <v-card v-if="selectedModel && usageKind" :title="selectedModel.name" :subtitle="selectedModel.id">
      <v-card-text><ModelUsage :kind="usageKind" :model-id="selectedModel.id" :device-id="deviceId ?? ''" /></v-card-text>
      <v-card-actions><v-spacer /><v-btn variant="text" @click="usageOpen = false">{{ isEnglish ? "Close" : "关闭" }}</v-btn></v-card-actions>
    </v-card>
  </v-dialog>

  <v-dialog v-model="open" max-width="560" :aria-label="selected?.ability.label" @after-leave="restoreFocus">
    <v-card v-if="selected" :title="selected.ability.label" :subtitle="selected.model">
      <v-card-text>
        <p class="model-ability-description">{{ selected.ability.description }}</p>
        <p v-if="selected.ability.detail" class="model-ability-detail">{{ selected.ability.detail }}</p>
      </v-card-text>
      <v-card-actions>
        <v-btn v-if="selected.sourceUrl" variant="text" append-icon="mdi-open-in-new" :href="selected.sourceUrl" target="_blank" rel="noreferrer">{{ labels.source }}</v-btn>
        <v-spacer /><v-btn variant="text" @click="open = false">{{ labels.close }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.model-table-shell { overflow-x: auto; border: 1px solid var(--rr-border); border-radius: 8px; background: var(--rr-surface); }
.model-table-shell:focus-visible { outline: 2px solid var(--rr-accent); outline-offset: 2px; }
.model-table { width: 100%; min-width: 820px; border-collapse: collapse; table-layout: fixed; }
.model-table th { padding: 11px 14px; color: var(--rr-muted-soft); background: var(--rr-input); font-size: 11px; font-weight: 800; text-align: left; white-space: nowrap; }
.model-table td { padding: 14px; border-top: 1px solid var(--rr-border); color: var(--rr-muted-soft); font-size: 13px; vertical-align: middle; }
.model-row:hover { background: var(--rr-subtle); }
.model-column { width: 22%; }
.capability-column { width: 38%; }
.size-column { width: 8%; }
.runtime-column { width: 12%; }
.source-column { width: 9%; }
.action-column { width: 11%; }
.model-table-name { display: grid; min-width: 0; gap: 3px; }
.model-table-name strong { color: var(--rr-heading); font-size: 15px; line-height: 1.3; overflow-wrap: anywhere; }
.model-name-button { justify-self: start; text-align: start; color: var(--rr-heading); font-weight: 700; font-size: 15px; overflow-wrap: anywhere; }
.model-name-button:hover, .model-name-button:focus-visible { text-decoration: underline; }
.model-table-name code { color: var(--rr-muted); font-size: 10px; overflow-wrap: anywhere; }
.model-table-abilities { display: flex; flex-wrap: wrap; gap: 5px; }
.model-table-abilities :deep(button:focus-visible) { outline: 2px solid var(--rr-accent); outline-offset: 1px; }
.model-table-size { white-space: nowrap; }
.model-table td:last-child, .model-table th:last-child { text-align: right; }
.model-ability-detail { margin-top: 10px; overflow-wrap: anywhere; }
.model-ability-description, .model-ability-detail { white-space: pre-line; line-height: 1.6; }
</style>
