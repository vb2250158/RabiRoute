<script setup lang="ts">
import type { QqHistoryRecord } from '../../../../../ribiwebgui/src/qqMessagePresentation';
import { useI18n } from '../../../../../ribiwebgui/src/i18n/index';
defineProps<{record:QqHistoryRecord;senderName?:string}>();
defineEmits<{close:[]}>();
const {t,locale}=useI18n();
</script>
<template>
  <v-dialog :model-value="true" max-width="560" @update:model-value="!$event&&$emit('close')">
    <v-card :title="t('消息详情')">
      <v-card-text><dl class="qq-message-metadata">
        <dt>{{ t('时间') }}</dt><dd>{{ record.time>0?new Date(record.time*1000).toLocaleString(locale):'—' }}</dd>
        <dt>{{ t('发送人') }}</dt><dd data-no-i18n>{{ senderName }}<span v-if="record.sender&&record.sender!==senderName"> · {{ record.sender }}</span></dd>
        <dt>{{ t('方向') }}</dt><dd>{{ t(record.direction==='outbound'?'发出':record.direction==='inbound'?'收到':'系统') }}</dd>
        <template v-if="record.status"><dt>{{ t('状态') }}</dt><dd data-no-i18n>{{ record.status }}</dd></template>
        <dt>{{ t('会话与来源') }}</dt><dd data-no-i18n>{{ record.gatewayId }}<span v-if="record.instanceId"> · {{ record.instanceId }}</span><br>{{ record.conversationKey }}</dd>
        <dt>{{ t('消息 ID') }}</dt><dd data-no-i18n>{{ record.messageId || record.id }}</dd>
      </dl></v-card-text>
      <v-card-actions><v-spacer /><v-btn @click="$emit('close')">{{ t('关闭') }}</v-btn></v-card-actions>
    </v-card>
  </v-dialog>
</template>
<style scoped>
.qq-message-metadata {display:grid;grid-template-columns:80px minmax(0,1fr);gap:12px;font-size:14px;}
.qq-message-metadata dt {color:rgba(var(--v-theme-on-surface),.6);}
.qq-message-metadata dd {margin:0;overflow-wrap:anywhere;white-space:pre-wrap;}
</style>
