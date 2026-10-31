<script setup lang="ts">
import { useI18n, localeOptions } from "../i18n";

const { locale, setLocale } = useI18n();

const options = localeOptions;
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
        :aria-label="options.find(option => option.locale === locale)?.ariaLabel"
        data-no-i18n
      >
        {{ options.find(option => option.locale === locale)?.short }}
      </v-btn>
    </template>

    <v-list class="locale-menu" density="compact" min-width="190" data-no-i18n>
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

<style scoped>
.locale-menu :deep(.v-list-item-subtitle) {
  color: var(--rr-muted-soft) !important;
  opacity: 1 !important;
}
</style>
