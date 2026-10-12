<script setup lang="ts">
import PeerServerSelect from "./PeerServerSelect.vue";
const emit = defineEmits<{ changed: [deviceId: string] }>();
</script>

<template>
  <PeerServerSelect class="speech-server-picker" label="语音服务器" persist-selection @changed="deviceId => emit('changed', deviceId)" />
</template>
