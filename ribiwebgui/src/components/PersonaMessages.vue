<script setup lang="ts">
import { computed, defineAsyncComponent, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useGatewayStore } from "../stores/gatewayStore";
import { useRoleStore } from "../stores/roleStore";
import { translateText } from "../i18n";
import { routesForPersona } from "../persona/personaMessageRoutes";

const RouteConfigPage = defineAsyncComponent(() => import("../pages/RouteConfigPage.vue"));
const store = useGatewayStore();
const roles = useRoleStore();
const route = useRoute();
const router = useRouter();
const routes = computed(() => routesForPersona(store.gateways, roles.selectedRoleId, roles.sourceDeviceId));
const selected = computed(() => routes.value.find(item => item.id === store.selectedGatewayId));
const unassigned = computed(() => store.gateways.filter(item => !item.agentRoleId));

watch(() => [roles.selectedRoleId, roles.sourceDeviceId, route.query.route, routes.value.map(item => item.id).join("|")] as const, () => {
  const requested = String(route.query.route || "");
  const next = routes.value.find(item => item.id === requested || item.configName === requested)
    || routes.value.find(item => item.id === store.selectedGatewayId) || routes.value[0];
  if (next) store.selectGateway(next.id);
}, { immediate: true });

function selectRoute(id: string): void {
  if (id === selected.value?.id) return;
  if (store.dirty && !window.confirm(translateText("当前配置有未保存修改。确定要切换吗？"))) return;
  store.selectGateway(id);
  void router.replace({ query: { ...route.query, tab: "messages", route: id } });
}

function bindRoute(id: string): void {
  const target = store.gateways.find(item => item.id === id);
  if (!target || target.agentRoleId) return;
  target.agentRoleId = roles.selectedRoleId;
  target.agentRoleDeviceId = roles.sourceDeviceId || undefined;
  target.agentRoleFile = "persona.md";
  store.touch();
  store.selectGateway(id);
  void router.replace({ query: { ...route.query, tab: "messages", route: id } });
}

function addRoute(): void {
  store.addGateway();
  bindRoute(store.selectedGatewayId);
}
</script>

<template>
  <section class="persona-messages">
    <div class="d-flex align-center ga-3 flex-wrap mb-4">
      <v-select v-if="routes.length" :model-value="selected?.id" :items="routes.map(item => ({ title: item.routeName || item.name || item.id, value: item.id }))" label="消息路由" hide-details style="max-width: 420px" @update:model-value="value => selectRoute(String(value || ''))" />
      <v-btn prepend-icon="mdi-plus" variant="tonal" :disabled="!roles.ready || store.loading || store.saving" @click="addRoute">新增消息路由</v-btn>
    </div>
    <v-alert v-if="!routes.length" type="info" variant="tonal" class="mb-4">当前角色还没有消息路由。新增路由后配置消息端和处理 Agent。</v-alert>
    <v-card v-if="unassigned.length" class="app-card section-card mb-4">
      <div class="section-title">未关联角色的路由</div>
      <div v-for="item in unassigned" :key="item.id" class="d-flex align-center justify-space-between ga-3 mt-2">
        <span data-no-i18n>{{ item.routeName || item.name || item.id }}</span>
        <v-btn size="small" variant="tonal" :disabled="!roles.ready || store.saving" @click="bindRoute(item.id)">关联到当前角色</v-btn>
      </div>
    </v-card>
    <RouteConfigPage v-if="selected" embedded />
  </section>
</template>
