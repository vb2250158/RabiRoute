<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import QuickSetupDialog from "./components/QuickSetupDialog.vue";
import { useGatewayStore } from "./stores/gatewayStore";
import { adapterLabel, gatewayAdapterTypes } from "./utils/gatewayHelpers";

const store = useGatewayStore();
const route = useRoute();
const drawer = ref(true);
const quickSetupOpen = ref(false);
const snackbar = ref("");

const navItems = [
  { title: "总览", icon: "mdi-view-dashboard-outline", to: "/overview" },
  { title: "路由配置", icon: "mdi-routes", to: "/routes" },
  { title: "人格与模板", icon: "mdi-account-heart-outline", to: "/persona" },
  { title: "运行日志", icon: "mdi-console-line", to: "/runtime" }
];

const managerConnected = computed(() => !store.managerError);
const pageTitle = computed(() => String(route.meta.title || "RibiWebGUI"));

onMounted(async () => {
  drawer.value = window.innerWidth >= 960;
  await store.load();
  quickSetupOpen.value = store.quickSetupNeeded;
  window.addEventListener("beforeunload", beforeUnload);
});

onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", beforeUnload);
});

watch(() => store.quickSetupNeeded, (needed) => {
  if (needed && !quickSetupOpen.value) quickSetupOpen.value = true;
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
          <div class="section-note">v{{ store.meta.version }}</div>
        </div>
      </div>

      <v-divider />

      <div class="sidebar-body">
        <v-card class="route-picker mb-3" variant="flat">
          <v-card-text>
            <div class="d-flex justify-space-between align-center mb-2">
              <span class="section-note">路由配置</span>
              <v-chip size="small" color="secondary" variant="tonal">{{ store.gateways.length }}</v-chip>
            </div>
            <v-select
              :model-value="store.selectedGatewayId"
              :items="store.gateways.map(g => ({ title: `${store.configNameFor(g)} · ${gatewayAdapterTypes(g).map(adapterLabel).join(' + ')}`, value: g.id }))"
              label="当前路由"
              @update:model-value="value => selectGateway(String(value || ''))"
            />
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
          <v-btn block class="sidebar-footer-btn" variant="tonal" color="primary" prepend-icon="mdi-lightning-bolt-outline" @click="quickSetupOpen = true">
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
      </v-toolbar-title>
      <v-spacer />
      <div class="topbar-actions">
        <v-chip class="manager-chip" :color="managerConnected ? 'success' : 'error'" variant="tonal" size="small">
          <v-icon start size="14">mdi-circle</v-icon>
          <span class="manager-chip-text">Manager {{ managerConnected ? "已连接" : "未连接" }}</span>
        </v-chip>
        <v-btn icon="mdi-refresh" :loading="store.loading" aria-label="刷新状态" @click="refresh" />
        <v-btn class="desktop-action" prepend-icon="mdi-plus" variant="tonal" @click="store.addGateway">新增路由配置</v-btn>
        <v-btn class="mobile-action" icon="mdi-plus" variant="tonal" aria-label="新增路由配置" @click="store.addGateway" />
        <v-btn class="desktop-action" color="primary" prepend-icon="mdi-content-save" :loading="store.saving" @click="save">
          保存配置
        </v-btn>
        <v-btn class="mobile-action" color="primary" icon="mdi-content-save" :loading="store.saving" aria-label="保存配置" @click="save" />
      </div>
    </v-app-bar>

    <v-main>
      <v-alert v-if="store.dirty" type="warning" variant="tonal" class="dirty-banner" density="comfortable">
        <div class="d-flex align-center justify-space-between ga-3 flex-wrap">
          <span>当前配置有未保存修改。保存后 Manager 才会使用最新配置。</span>
          <v-btn size="small" color="warning" variant="flat" prepend-icon="mdi-content-save" :loading="store.saving" @click="save">
            保存
          </v-btn>
        </div>
      </v-alert>
      <v-alert v-if="store.error" type="error" variant="tonal" class="ma-4">{{ store.error }}</v-alert>
      <router-view />
    </v-main>

    <QuickSetupDialog v-model="quickSetupOpen" />
    <v-snackbar :model-value="!!snackbar" timeout="1800" @update:model-value="value => { if (!value) snackbar = '' }">
      {{ snackbar }}
    </v-snackbar>
  </v-app>
</template>
