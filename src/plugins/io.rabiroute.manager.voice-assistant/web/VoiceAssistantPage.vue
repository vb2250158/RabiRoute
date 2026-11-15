<script setup lang="ts">
import {onBeforeUnmount,onMounted,ref} from 'vue';
import {mountAssistantPanel} from './assistant-app';
const container=ref<HTMLElement>();let dispose:(()=>void)|undefined;
onMounted(()=>{if(container.value)dispose=mountAssistantPanel(container.value)});
onBeforeUnmount(()=>{dispose?.()});
</script>
<template><section class="rabi-voice-assistant"><h1>语音助手</h1><div ref="container" /></section></template>
<style scoped>.rabi-voice-assistant{min-height:100%;padding:18px 24px}.rabi-voice-assistant h1{font-size:22px;margin-bottom:8px}</style>
