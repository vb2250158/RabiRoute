<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "../i18n";

const route = useRoute();
const { t } = useI18n();
const pageTitle = computed(() => t(String(route.meta.title || "RibiWebGUI")));
</script>

<template>
  <div class="page-shell" aria-busy="true">
    <v-card class="section-card" variant="flat">
      <v-progress-linear indeterminate color="primary" />
      <v-card-text class="pa-6">
        <div class="section-note mb-2">{{ pageTitle }}</div>
        <div class="text-h6 font-weight-bold">{{ t("页面已切换，正在加载内容") }}</div>
      </v-card-text>
    </v-card>
  </div>
</template>
