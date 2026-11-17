<script setup lang="ts">
import {onBeforeUnmount,onMounted,ref} from 'vue';
import {mountAssistantPanel} from './assistant-app';
import {managerResourceUrl} from '../../../../ribiwebgui/src/managerApi';
import {managerAvatarUrl} from './avatar-resource-url.mjs';
const container=ref<HTMLElement>();let dispose:(()=>void)|undefined;
onMounted(()=>{if(container.value)dispose=mountAssistantPanel(container.value,{resolveAvatarUrl:url=>managerAvatarUrl(url,managerResourceUrl,window.location.href)})});
onBeforeUnmount(()=>{dispose?.()});
</script>
<template><section class="rabi-voice-assistant"><h1>语音助手</h1><div ref="container" class="rabi-voice-assistant-body" /></section></template>
<style scoped>
.rabi-voice-assistant {
  box-sizing: border-box;
  height: var(--rr-content-height, calc(100dvh - var(--v-layout-top, 64px) - var(--v-layout-bottom, 0px)));
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 18px 24px;
}
.rabi-voice-assistant h1 {
  flex-shrink: 0;
  font-size: 22px;
  margin: 0 0 8px;
}
.rabi-voice-assistant-body {
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}
.rabi-voice-assistant-body :deep(.va-panel) { width: 100%; }
.rabi-voice-assistant-body :deep(.va-full-page) { overflow: auto; }
.rabi-voice-assistant-body :deep(.rabi-assistant-settings) {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.rabi-voice-assistant-body :deep(.rabi-settings-heading) { flex-shrink: 0; }
.rabi-voice-assistant-body :deep(.va-settings) {
  flex: 1;
  width: 100%;
  height: auto;
  min-height: 0;
}
/* Supply the native controls that the standalone page normally styles. */
:where(.rabi-voice-assistant-body) :deep(button) {
  border: 1px solid var(--va-line, #31454f);
  border-radius: 8px;
  padding: 8px 12px;
  background: var(--rr-surface-glass, #14242d);
  color: inherit;
  font: inherit;
  cursor: pointer;
}
:where(.rabi-voice-assistant-body) :deep(button:disabled) {
  opacity: .5;
  cursor: not-allowed;
}
:where(.rabi-voice-assistant-body) :deep(button:focus-visible),
.rabi-voice-assistant-body :deep(.va-compose input:focus-visible) {
  outline: 2px solid var(--va-accent, #69d6bd);
  outline-offset: 2px;
}
.rabi-voice-assistant-body :deep(.va-compose input) {
  border: 1px solid var(--va-line, #31454f);
  border-radius: 8px;
  padding: 10px 12px;
  background: var(--rr-surface-glass, #14242d);
  color: inherit;
  font: inherit;
}
@media (max-width: 600px) {
  .rabi-voice-assistant { padding: 12px; }
}
</style>
