<script setup lang="ts">
import type { MessageContextRecord } from '../../../../messageContextStore';
import { renderMarkdownPreview } from '../../../../../ribiwebgui/src/markdownPreview';
import ChatMessageBody from './ChatMessageBody.vue';
import { useI18n } from '../../../../../ribiwebgui/src/i18n/index';
defineProps<{record:MessageContextRecord;expanded:boolean}>();
defineEmits<{expand:[]}>();
const {t}=useI18n();
</script>
<template>
  <div class="endpoint-message" :class="{'endpoint-outgoing':record.direction==='outbound','endpoint-event':record.adapter==='system'||record.adapter==='heartbeat'}">
    <article class="history-record endpoint-bubble" :data-entry-id="record.id">
      <div class="text-caption text-medium-emphasis mb-1" data-no-i18n>{{record.sender}}<template v-if="record.target"> → {{record.target}}</template><template v-if="record.status"> · {{record.status}}</template></div>
      <ChatMessageBody :expanded="expanded" @toggle="$emit('expand')"><div class="endpoint-body" v-html="renderMarkdownPreview(record.text)" data-no-i18n /></ChatMessageBody>
      <div v-if="record.attachments?.length" class="d-flex flex-wrap ga-2 mt-2"><v-chip v-for="(attachment,index) in record.attachments" :key="attachment.id||index" size="small" data-no-i18n>{{attachment.name||attachment.kind||t('附件')}}</v-chip></div>
      <details class="mt-2 text-caption text-medium-emphasis"><summary>{{t('详细信息')}}</summary><div data-no-i18n>{{record.messageId||record.id}}</div><div data-no-i18n>{{record.conversationKey}}</div></details>
    </article>
  </div>
</template>
<style scoped>
.endpoint-message{display:flex;min-width:0;}.endpoint-outgoing{justify-content:flex-end;}.endpoint-bubble{max-width:88%;padding:10px 13px;background:rgba(var(--v-theme-on-surface),.075);border-radius:10px;overflow-wrap:anywhere;}
.endpoint-outgoing .endpoint-bubble{background:rgba(var(--v-theme-secondary),.14);}.endpoint-event .endpoint-bubble{background:transparent;border-left:2px solid rgba(var(--v-theme-on-surface),.18);border-radius:0;}
.endpoint-summary{white-space:pre-wrap;}.endpoint-body :deep(> :first-child){margin-top:0;}.endpoint-body :deep(> :last-child){margin-bottom:0;}.endpoint-body :deep(pre),.endpoint-body :deep(table){max-width:100%;overflow-x:auto;}.endpoint-body :deep(ul),.endpoint-body :deep(ol){padding-left:1.5em;}.endpoint-body :deep(a){color:rgb(var(--v-theme-secondary));}
@media(max-width:760px){.endpoint-bubble{max-width:95%;}}
</style>
