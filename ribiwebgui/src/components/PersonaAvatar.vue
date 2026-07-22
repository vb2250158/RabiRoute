<script setup lang="ts">
import { computed, ref, watch } from "vue";

const props = withDefaults(defineProps<{
  roleId?: string;
  avatarUrl?: string;
  size?: number | string;
  rounded?: string | number | boolean;
}>(), {
  roleId: "",
  avatarUrl: "",
  size: 40,
  rounded: "lg"
});

const failed = ref(false);
const initial = computed(() => Array.from(props.roleId.trim())[0]?.toUpperCase() || "R");
const showImage = computed(() => Boolean(props.avatarUrl) && !failed.value);
const fallbackStyle = computed(() => {
  const numericSize = Number(props.size);
  return Number.isFinite(numericSize) ? { fontSize: `${Math.max(12, numericSize * 0.42)}px` } : undefined;
});

watch(() => props.avatarUrl, () => {
  failed.value = false;
});
</script>

<template>
  <v-avatar
    class="persona-avatar"
    :size="size"
    :rounded="rounded"
    color="secondary"
    :aria-label="roleId ? `${roleId} 人格头像` : '人格头像'"
  >
    <v-img v-if="showImage" :src="avatarUrl" :alt="roleId ? `${roleId} 人格头像` : '人格头像'" cover @error="failed = true" />
    <span v-else-if="roleId" class="persona-avatar__fallback" :style="fallbackStyle" aria-hidden="true">{{ initial }}</span>
    <v-icon v-else aria-hidden="true">mdi-account-off-outline</v-icon>
  </v-avatar>
</template>

<style scoped>
.persona-avatar {
  border: 1px solid rgba(var(--v-theme-secondary), 0.28);
  box-shadow: 0 6px 18px rgba(14, 72, 88, 0.12);
  flex: 0 0 auto;
}

.persona-avatar__fallback {
  font-weight: 900;
  letter-spacing: -0.04em;
}
</style>
