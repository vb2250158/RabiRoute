<script setup lang="ts">
import { useI18n, type AppLocale } from "../i18n";

const { locale, setLocale } = useI18n();

const options: Array<{ locale: AppLocale; label: string; detail: string }> = [
  { locale: "zh-CN", label: "简体中文", detail: "Chinese" },
  { locale: "en", label: "English", detail: "English" }
];
</script>

<template>
  <v-menu location="bottom end">
    <template #activator="{ props }">
      <v-btn
        v-bind="props"
        class="locale-switcher"
        variant="tonal"
        color="secondary"
        prepend-icon="mdi-translate"
        :aria-label="locale === 'en' ? 'Language: English' : '语言：简体中文'"
      >
        {{ locale === "en" ? "EN" : "中" }}
      </v-btn>
    </template>
    <v-list class="locale-menu" density="compact" min-width="190">
      <v-list-item
        v-for="option in options"
        :key="option.locale"
        :active="locale === option.locale"
        :title="option.label"
        :subtitle="option.detail"
        prepend-icon="mdi-web"
        @click="setLocale(option.locale)"
      >
        <template #append>
          <v-icon v-if="locale === option.locale" color="secondary" size="18">mdi-check</v-icon>
        </template>
      </v-list-item>
    </v-list>
  </v-menu>
</template>
