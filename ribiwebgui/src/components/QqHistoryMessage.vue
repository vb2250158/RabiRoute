<script setup lang="ts">
import { useI18n } from '../i18n';
import type { QqHistoryRecord, QqSelection } from '../qqMessagePresentation';
import QqAvatar from './QqAvatar.vue';
import QqMessageContent from './QqMessageContent.vue';

defineProps<{ record: QqHistoryRecord; avatarId?: string; senderName?: string; selection?: QqSelection; names?: Record<string, string>; active: boolean; expanded: boolean }>();
defineEmits<{ expand: []; details: [] }>();
const { t } = useI18n();
</script>

<template>
  <div class="qq-message-row" :class="{'qq-row-outgoing':record.direction==='outbound'}">
    <QqAvatar :id="avatarId" :name="senderName" :size="36" />
    <div class="qq-message-stack">
      <div class="qq-sender" data-no-i18n>{{ senderName }}</div>
      <div class="qq-bubble-line">
        <article class="history-record qq-bubble" :class="{outgoing:record.direction==='outbound'}" :data-entry-id="record.id" @contextmenu.prevent="$emit('details')">
          <QqMessageContent :class="{'qq-long-message':!expanded&&record.text.length>600}" :text="record.text" :structured-parts="record.qqParts" :message-id="record.messageId" :selection="selection" :names="names" :attachments="record.attachments" :active="active" />
          <button v-if="record.text.length>600" class="qq-expand" @click="$emit('expand')">{{ t(expanded?'收起':'展开全文') }}</button>
        </article>
        <v-btn class="qq-message-details" icon="mdi-dots-horizontal" size="x-small" variant="text" :aria-label="t('消息详情')" :title="t('消息详情')" @click="$emit('details')" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.qq-message-row {display:flex;align-items:flex-start;gap:10px;}
.qq-row-outgoing {flex-direction:row-reverse;}
.qq-message-stack {min-width:0;max-width:min(82%,780px);}
.qq-sender {color:rgba(var(--v-theme-on-surface),.6);font-size:12px;line-height:18px;margin:0 0 4px;overflow-wrap:anywhere;}
.qq-row-outgoing .qq-sender {text-align:right;}
.qq-bubble-line {display:flex;align-items:center;gap:3px;}
.qq-row-outgoing .qq-bubble-line {flex-direction:row-reverse;}
.qq-bubble {width:fit-content;min-width:0;padding:9px 12px;border-radius:10px;background:rgba(var(--v-theme-on-surface),.075);overflow-wrap:anywhere;}
.qq-bubble.outgoing {background:rgba(var(--v-theme-secondary),.14);}
.qq-message-details {flex:none;opacity:0;}
.qq-message-row:hover .qq-message-details,.qq-message-row:focus-within .qq-message-details {opacity:1;}
.qq-long-message {display:-webkit-box;-webkit-line-clamp:12;-webkit-box-orient:vertical;overflow:hidden;}
.qq-expand {display:block;color:rgb(var(--v-theme-secondary));font-size:12px;margin-top:8px;padding:2px 0;}
.qq-expand:focus-visible {outline:2px solid currentColor;outline-offset:3px;}
@media(hover:none) {.qq-message-details {opacity:1;}}
@media(max-width:760px) {.qq-message-stack {max-width:calc(100% - 46px);} .qq-bubble-line {gap:0;} .qq-message-details {width:24px;height:28px;}}
</style>
