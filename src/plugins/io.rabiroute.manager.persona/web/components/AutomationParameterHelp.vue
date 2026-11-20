<script setup lang="ts">
defineProps<{ text: string }>();
</script>

<template>
  <v-tooltip :text="text" location="top" max-width="300">
    <template #activator="{ props }">
      <v-icon v-bind="props" icon="mdi-help-circle-outline" size="16" tabindex="0"
        role="img" :aria-label="text" class="text-medium-emphasis" @click.stop />
    </template>
  </v-tooltip>
</template>
