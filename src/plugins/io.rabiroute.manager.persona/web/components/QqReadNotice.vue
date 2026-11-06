<script setup lang="ts">
import { useI18n } from '../../../../../ribiwebgui/src/i18n/index';
defineProps<{summary:string;detail?:string}>();
defineEmits<{retry:[]}>();
const {t}=useI18n();
</script>
<template>
  <div class="qq-read-notice" role="status">
    <div class="qq-read-notice-line"><v-icon icon="mdi-information-outline" size="16" /><span>{{ t(summary) }}</span><v-btn icon="mdi-refresh" size="x-small" variant="text" :aria-label="t('重试')" @click="$emit('retry')" /></div>
    <details v-if="detail" class="qq-read-notice-detail"><summary>{{ t('详细信息') }}</summary><div data-no-i18n>{{ detail.trim() }}</div></details>
  </div>
</template>
<style scoped>
.qq-read-notice {flex:0 0 auto;min-width:0;max-width:100%;padding:8px 10px;font-size:12px;color:rgb(var(--v-theme-warning));background:rgba(var(--v-theme-warning),.065);overflow-wrap:anywhere;}
.qq-read-notice-line {display:flex;align-items:flex-start;gap:6px;line-height:20px;}
.qq-read-notice-line>span {min-width:0;flex:1;}
.qq-read-notice-line>.v-icon {margin-top:2px;flex:none;}
.qq-read-notice-line>.v-btn {flex:none;}
.qq-read-notice-detail {margin:4px 0 0 22px;font-size:11px;}
.qq-read-notice-detail summary {cursor:pointer;}
.qq-read-notice-detail>div {max-height:140px;overflow:auto;white-space:pre-wrap;padding-top:6px;}
</style>
