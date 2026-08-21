<script setup lang="ts">
import type { WebRendererContribution } from "../pluginRenderers";

defineProps<{
  renderers: readonly WebRendererContribution[];
  context?: unknown;
}>();
</script>

<template>
  <component
    :is="renderer.component"
    v-for="renderer in renderers"
    :key="renderer.key"
    :context="context"
  />
</template>
