<script setup lang="ts">
import { onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";

const route = useRoute();
const router = useRouter();
const destination = { path: "/model-services", query: { ...route.query, settings: "1", section: "speech-diagnostics" } };
onMounted(() => { void router.replace(destination); });
</script>

<template>
  <RouterLink :to="destination">打开语音服务诊断</RouterLink>
</template>
