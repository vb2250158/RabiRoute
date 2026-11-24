<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(defineProps<{ endpoint: string; fallback: string; size?: number }>(), { size: 34 });

const qqArtwork = new URL("../assets/connector-icons/qqbot.jpg", import.meta.url).href;

const icons: Readonly<Record<string, string>> = {
  napcat: qqArtwork,
  qqbot: qqArtwork,
  weixin: new URL("../assets/connector-icons/weixin.jpg", import.meta.url).href,
  wecom: new URL("../assets/connector-icons/wecom.jpg", import.meta.url).href,
  feishu: new URL("../assets/connector-icons/feishu.jpg", import.meta.url).href,
  rabilink: new URL("../../../../../assets/rabiroute-icon.png", import.meta.url).href,
  xiaomiHome: new URL("../assets/connector-icons/xiaomi-home.jpg", import.meta.url).href
};

const artwork = computed(() => icons[props.endpoint]);
</script>

<template>
  <v-avatar :size="size" rounded="lg" :color="artwork ? 'transparent' : 'surface-variant'" aria-hidden="true">
    <img v-if="artwork" :src="artwork" alt="" width="100" height="100" />
    <v-icon v-else :icon="fallback" :size="Math.round(size * 0.6)" />
  </v-avatar>
</template>

<style scoped>
img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
</style>
