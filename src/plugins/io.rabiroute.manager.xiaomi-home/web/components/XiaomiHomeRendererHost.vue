<script setup lang="ts">
import { ref } from "vue";
import XiaomiAccountLogin from "./XiaomiAccountLogin.vue";
import type { WebRendererContribution } from "../../../../../ribiwebgui/src/pluginRenderers";
import TrustedWebRendererHost from "../../../../../ribiwebgui/src/components/TrustedWebRendererHost.vue";

const props = defineProps<{
  renderers: readonly WebRendererContribution[];
  context?: { loginRequested?: boolean };
}>();

const activeTab = ref(props.context?.loginRequested ? "account" : "setup");
const tabs = [
  { value: "setup", title: "登录", rendererId: "builtin.xiaomi-home-auth.v1" },
  { value: "settings", title: "设置", rendererId: "builtin.xiaomi-home-message-endpoint.v1" },
  { value: "devices", title: "设备列表", rendererId: "builtin.xiaomi-home-devices.v1" },
  { value: "account", title: "小米账号", rendererId: "" }
] as const;
</script>

<template>
  <div class="xiaomi-home-tabs">
    <v-tabs v-model="activeTab" aria-label="米家" color="primary" class="mb-4">
      <v-tab v-for="tab in tabs" :key="tab.value" :value="tab.value">{{ tab.title }}</v-tab>
    </v-tabs>
    <section
      v-for="tab in tabs"
      v-show="activeTab === tab.value"
      :key="tab.value"
      :aria-label="tab.title"
    >
      <XiaomiAccountLogin v-if="tab.value === 'account' && activeTab === 'account'" :auto-start="context?.loginRequested" />
      <TrustedWebRendererHost
        v-if="tab.value !== 'account' && (tab.value !== 'devices' || activeTab === 'devices')"
        :renderers="renderers.filter(renderer => renderer.rendererId === tab.rendererId)"
        :context="context"
      />
    </section>
  </div>
</template>
