<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import QuickSetupDialog from "./components/QuickSetupDialog.vue";
import { useGatewayStore } from "./stores/gatewayStore";
import { adapterLabel, adaptersNeedGatewayRuntime, configNameFor, gatewayAdapterTypes, isMessageInputsDisabled } from "./utils/gatewayHelpers";

const store = useGatewayStore();
const route = useRoute();
const router = useRouter();
const drawer = ref(true);
const snackbar = ref("");

const navItems = [
  { title: "控制台", icon: "mdi-view-dashboard-outline", to: "/overview" },
  { title: "消息适配器", icon: "mdi-puzzle-outline", to: "/routes" },
  { title: "Rabi 人格", icon: "mdi-account-heart-outline", to: "/persona" },
  { title: "日志诊断", icon: "mdi-console-line", to: "/runtime" }
];

const managerConnected = computed(() => !store.managerError);
const pageTitle = computed(() => String(route.meta.title || "RibiWebGUI"));
const selectedGatewayName = computed(() => store.selectedGateway ? store.configNameFor(store.selectedGateway) : "未选择路由");
const selectedGatewayAdapters = computed(() => {
  if (!store.selectedGateway) return "等待配置";
  const text = gatewayAdapterTypes(store.selectedGateway).map(adapterLabel).join(" + ");
  return isMessageInputsDisabled(store.selectedGateway) ? `已禁用 · ${text}` : text;
});
const selectedRuntimeLabel = computed(() => {
  if (!store.selectedGateway) return "未配置";
  if (store.selectedGateway.enabled === false || store.selectedRuntime.enabled === false) return "禁用中";
  if (!adaptersNeedGatewayRuntime(gatewayAdapterTypes(store.selectedGateway))) return "启用中";
  return store.selectedRuntime.running ? "运行中" : "已停止";
});

onMounted(async () => {
  drawer.value = window.innerWidth >= 960;
  await store.load();
  if (store.gateways.length === 0) store.openQuickSetup();
  window.addEventListener("beforeunload", beforeUnload);
});

onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", beforeUnload);
});

async function save() {
  await store.save();
  snackbar.value = "配置已保存";
}

async function refresh() {
  await store.load();
  snackbar.value = "状态已刷新";
}

function beforeUnload(event: BeforeUnloadEvent) {
  if (!store.dirty) return;
  event.preventDefault();
  event.returnValue = "";
}

function canLeaveDirtyState(): boolean {
  return !store.dirty || window.confirm("当前配置有未保存修改。确定要切换吗？");
}

function selectGateway(id: string) {
  if (!canLeaveDirtyState()) return;
  store.selectGateway(id);
  // 同步 URL：仅在有 id 参数的页面才更新
  const gw = store.gateways.find(g => g.id === id);
  const name = gw ? configNameFor(gw) : id;
  const currentPath = route.path;
  if (currentPath.startsWith("/routes")) router.replace(`/routes/${name}`);
  else if (currentPath.startsWith("/persona")) router.replace(`/persona/${name}`);
}
</script>

<template>
  <v-app>
    <v-navigation-drawer v-model="drawer" width="276" class="left-sidebar">
      <div class="sidebar-brand">
        <v-avatar rounded="lg" size="46">
          <v-img src="/assets/rabiroute-icon.png" alt="RabiRoute" />
        </v-avatar>
        <div class="min-w-0">
          <div class="font-weight-black text-primary text-h6 lh-1">RabiRoute</div>
          <div class="section-note">星海消息分诊台 · v{{ store.meta.version }}</div>
        </div>
      </div>

      <v-divider />

      <div class="sidebar-body">
        <v-card class="route-picker mb-3" variant="flat">
          <v-card-text>
            <div class="d-flex justify-space-between align-center mb-2">
              <span class="section-note">当前航线</span>
              <v-chip size="small" color="secondary" variant="tonal">{{ store.gateways.length }}</v-chip>
            </div>
            <v-select
              :model-value="store.selectedGatewayId"
              :items="store.gateways.map(g => ({ title: `${store.configNameFor(g)} · ${isMessageInputsDisabled(g) ? '已禁用 · ' : ''}${gatewayAdapterTypes(g).map(adapterLabel).join(' + ')}`, value: g.id }))"
              label="当前路由"
              @update:model-value="value => selectGateway(String(value || ''))"
            />
            <div class="route-picker-status">
              <span>{{ selectedRuntimeLabel }}</span>
              <b>{{ selectedGatewayAdapters }}</b>
            </div>
          </v-card-text>
        </v-card>

        <v-list nav density="comfortable" bg-color="transparent" class="sidebar-list">
          <v-list-item
            v-for="item in navItems"
            :key="item.to"
            :to="item.to"
            :prepend-icon="item.icon"
            :title="item.title"
            rounded="lg"
          />
        </v-list>
      </div>

      <template #append>
        <div class="sidebar-footer">
          <v-btn block class="sidebar-footer-btn" variant="tonal" color="primary" prepend-icon="mdi-lightning-bolt-outline" @click="store.openQuickSetup">
            快速配置
          </v-btn>
          <v-btn block class="sidebar-footer-btn" variant="text" prepend-icon="mdi-github" :href="store.meta.githubUrl" target="_blank">
            GitHub
          </v-btn>
          <v-btn block class="sidebar-footer-btn" variant="text" prepend-icon="mdi-folder-cog-outline" @click="store.openConfigFile('manager')">
            打开配置目录
          </v-btn>
        </div>
      </template>
    </v-navigation-drawer>

    <v-app-bar flat class="top-app-bar px-2">
      <v-app-bar-nav-icon @click="drawer = !drawer" />
      <v-toolbar-title class="topbar-title">
        <div class="font-weight-bold">{{ pageTitle }}</div>
        <div class="topbar-subtitle">{{ selectedGatewayName }}</div>
      </v-toolbar-title>
      <v-spacer />
      <div class="topbar-actions">
        <span v-if="store.dirty" class="dirty-hint">有未保存的修改</span>
        <v-chip class="manager-chip" :color="managerConnected ? 'success' : 'error'" variant="tonal" size="small">
          <v-icon start size="14">mdi-circle</v-icon>
          <span class="manager-chip-text">Manager {{ managerConnected ? "已连接" : "未连接" }}</span>
        </v-chip>
        <v-btn icon="mdi-refresh" :loading="store.loading" aria-label="刷新状态" @click="refresh" />
        <v-btn class="desktop-action" prepend-icon="mdi-plus" variant="tonal" @click="store.addGatewayAndOpenQuickSetup">新增航线</v-btn>
        <v-btn class="mobile-action" icon="mdi-plus" variant="tonal" aria-label="新增航线" @click="store.addGatewayAndOpenQuickSetup" />
        <v-btn class="desktop-action" color="primary" prepend-icon="mdi-content-save" :loading="store.saving" @click="save">
          保存配置
        </v-btn>
        <v-btn class="mobile-action" color="primary" icon="mdi-content-save" :loading="store.saving" aria-label="保存配置" @click="save" />
      </div>
    </v-app-bar>

    <v-main>
      <v-alert v-if="store.error" type="error" variant="tonal" class="ma-4">{{ store.error }}</v-alert>
      <router-view />
    </v-main>

    <QuickSetupDialog v-model="store.quickSetupDialogOpen" />
    <v-snackbar :model-value="!!snackbar" timeout="1800" @update:model-value="value => { if (!value) snackbar = '' }">
      {{ snackbar }}
    </v-snackbar>
  </v-app>
</template>
