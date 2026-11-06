<script setup lang="ts">
import { useI18n } from '../../../../../ribiwebgui/src/i18n/index';
import type { QqHistoryRecord, QqSelection, QqHistoryMessage } from '../../../../../ribiwebgui/src/qqMessagePresentation';
import QqAvatar from './QqAvatar.vue';
import QqMessageContent from './QqMessageContent.vue';
import ChatMessageBody from './ChatMessageBody.vue';

defineProps<{ record: QqHistoryRecord; avatarId?: string; senderName?: string; selection?: QqSelection; names?: Record<string, string>; active: boolean; readable?:boolean; expanded: boolean }>();
defineEmits<{ expand: []; details: []; image:[{blob:Blob;name:string}];quote:[QqHistoryMessage] }>();
const { t } = useI18n();
</script>

<template>
  <div class="qq-message-row" :class="{'qq-row-outgoing':record.direction==='outbound'}">
    <QqAvatar :id="avatarId" :name="senderName" :size="36" />
    <div class="qq-message-stack">
      <div class="qq-sender" data-no-i18n>{{ senderName }}</div>
      <div class="qq-bubble-line">
        <article class="history-record qq-bubble" :class="{outgoing:record.direction==='outbound'}" :data-entry-id="record.id" @contextmenu.prevent="$emit('details')">
          <ChatMessageBody :expanded="expanded" @toggle="$emit('expand')">
          <QqMessageContent :text="record.text" :structured-parts="record.qqParts" :message-id="record.messageId" :reply-to-message-id="record.replyToMessageId" :selection="selection" :names="names" :attachments="record.attachments" :active="active" :readable="readable" @image="$emit('image',$event)" @quote="$emit('quote',$event)" />
          </ChatMessageBody>
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
@media(hover:none) {.qq-message-details {opacity:1;}}
@media(max-width:760px) {.qq-message-stack {max-width:calc(100% - 46px);} .qq-bubble-line {gap:0;} .qq-message-details {width:24px;height:28px;}}
</style>
