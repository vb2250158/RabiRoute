<script setup lang="ts">
import { computed } from "vue";
import { useGatewayStore } from "../stores/gatewayStore";
import { isSpeechRouteVariableKey } from "@shared/speechControlContract";
const store = useGatewayStore();
const entries = computed(() => Object.entries(store.selectedGateway?.routeVariables || {}).filter(([key]) => !isSpeechRouteVariableKey(key)));
function rename(key: string, value: string, event: Event) { store.updateRouteVariable(key, (event.target as HTMLInputElement).value, value); }
</script>
<template>
  <v-card v-if="store.selectedGateway" class="app-card glass-card section-card my-4">
    <div class="section-title-row"><div class="section-title">路由变量</div><v-btn variant="tonal" prepend-icon="mdi-plus" @click="store.addRouteVariable">新增变量</v-btn></div>
    <div v-for="[key, value] in entries" :key="key" class="d-flex ga-3 mt-3">
      <v-text-field :model-value="key" label="变量名" @change="rename(key, value, $event)" />
      <v-text-field :model-value="value" label="变量值" @update:model-value="next => store.updateRouteVariable(key, key, String(next || ''))" />
      <v-btn icon="mdi-delete" color="error" variant="text" @click="store.removeRouteVariable(key)" />
    </div>
    <p v-if="!entries.length" class="mt-3">暂无自定义路由变量</p>
  </v-card>
</template>
