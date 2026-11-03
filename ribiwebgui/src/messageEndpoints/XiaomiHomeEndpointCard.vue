<script setup lang="ts">
import { computed } from "vue";
import { pluginCatalogStore } from "../pluginCatalogStore";
import XiaomiHomeRendererHost from "../components/XiaomiHomeRendererHost.vue";
import type { MessageEndpointCardContext } from "./messageEndpointCardContext";
defineProps<{ context?: MessageEndpointCardContext }>();
const renderers = computed(() => pluginCatalogStore.settingsRenderers.value.filter(renderer => renderer.slot === "xiaomiHome" && !renderer.endpointType));
</script>
<template><XiaomiHomeRendererHost :renderers="renderers" :context="context" /></template>
