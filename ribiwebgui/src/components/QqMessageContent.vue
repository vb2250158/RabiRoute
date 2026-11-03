<script setup lang="ts">
import {computed,onBeforeUnmount,ref,watch} from 'vue';
import type {MessageContextAttachment} from '../../../src/messageContextStore';
import {qqMessageParts,qqMessageUrl,qqMediaMime,type QqMessagePart,type QqSelection} from '../qqMessagePresentation';
import {usePersonaService} from '../persona/personaServiceClient';
import {useI18n} from '../i18n';
import {userFacingError} from '../userFacingError';
const props=defineProps<{text:string;messageId?:string|number;selection?:QqSelection;names?:Record<string,string>;attachments?:MessageContextAttachment[];active:boolean;structuredParts?:QqMessagePart[]}>();
const {fetch}=usePersonaService(),{t}=useI18n();
const parts=computed(()=>{
  const parsed=props.structuredParts?.slice()??qqMessageParts(props.text);
  if(!parsed.some(part=>part.kind==='media'))for(const [index,attachment] of (props.attachments??[]).entries())parsed.push({kind:'media',index,mediaKind:attachment.kind??'file',name:attachment.name||t('附件')});
  return parsed;
});
type Media={url:string;mime:string;name:string};
const media=ref(new Map<number,Media>()),errors=ref(new Map<number,string>()),pending=ref(new Set<number>());
const requests=new Map<number,AbortController>();
const messageUrl=computed(()=>props.selection&&props.messageId!==undefined?qqMessageUrl(props.selection,props.messageId):undefined);
function clear(){for(const request of requests.values())request.abort();requests.clear();pending.value.clear();for(const value of media.value.values())URL.revokeObjectURL(value.url);media.value.clear();errors.value.clear();}
async function openMedia(index:number){
  const url=messageUrl.value;if(!url||pending.value.has(index)||media.value.has(index)||!props.active)return;
  const controller=new AbortController();requests.set(index,controller);pending.value.add(index);errors.value.delete(index);
  try {
    const response=await fetch(url,{signal:controller.signal}),result=await response.json();
    if(!response.ok||result.code!==0)throw Error(t('QQ 原消息暂不可用'));
    const attachment=result.data.attachments?.find((item:{index:number})=>item.index===index);
    if(!attachment)throw Error(t('此附件暂不可用'));
    // Construct the exact admitted message endpoint ourselves; never navigate a CQ URL or local path.
    const contentUrl=url.replace('?',`/attachments/${index}?`);
    const content=await fetch(contentUrl,{signal:controller.signal});
    if(!content.ok)throw Error(t('此附件暂不可用'));
    const bytes=await content.arrayBuffer();if(controller.signal.aborted)return;
    const mime=qqMediaMime(new Uint8Array(bytes));
    media.value.set(index,{url:URL.createObjectURL(new Blob([bytes],{type:mime})),mime,name:attachment.name||t('附件')});
  }catch(cause){if(!controller.signal.aborted)errors.value.set(index,userFacingError(cause));}
  finally{if(requests.get(index)===controller){requests.delete(index);pending.value.delete(index);}}
}
watch(()=>[props.text,props.messageId,props.selection?.routeId,props.selection?.kind,props.selection?.target],clear);
watch(()=>props.active,active=>{if(!active)clear();});
onBeforeUnmount(clear);
</script>
<template>
  <div class="qq-message-content" data-no-i18n>
    <template v-for="(part,index) in parts" :key="index">
      <span v-if="part.kind==='text'">{{ part.text }}</span>
      <span v-else-if="part.kind==='mention'" class="qq-mention">@{{ part.target==='all'?t('全体成员'):names?.[part.target]||part.target }}</span>
      <div v-else-if="part.kind==='reply'" class="qq-quote">{{ t('引用消息') }} · {{ part.id }}</div>
      <span v-else-if="part.kind==='label'" class="qq-message-label">[{{ t(part.text) }}]</span>
      <div v-else-if="part.kind==='media'" class="qq-media">
        <template v-if="media.get(part.index)">
          <img v-if="media.get(part.index)!.mime.startsWith('image/')" :src="media.get(part.index)!.url" :alt="part.name" loading="lazy" />
          <audio v-else-if="media.get(part.index)!.mime.startsWith('audio/')" :src="media.get(part.index)!.url" controls preload="none" />
          <video v-else-if="media.get(part.index)!.mime.startsWith('video/')" :src="media.get(part.index)!.url" controls preload="metadata" />
          <a :href="media.get(part.index)!.url" :download="media.get(part.index)!.name">{{ t('下载') }} · {{ media.get(part.index)!.name }}</a>
        </template>
        <v-btn v-else variant="tonal" :prepend-icon="part.mediaKind==='image'?'mdi-image':part.mediaKind==='video'?'mdi-video':part.mediaKind==='record'?'mdi-microphone':'mdi-file-document-outline'" :disabled="!messageUrl" :loading="pending.has(part.index)" @click="openMedia(part.index)">{{ t(part.name) }}</v-btn>
        <div v-if="errors.get(part.index)" class="text-caption text-error" role="status">{{ errors.get(part.index) }}</div>
      </div>
    </template>
  </div>
</template>
<style scoped>
.qq-message-content {white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.65;}
.qq-mention {color:rgb(var(--v-theme-secondary));}
.qq-quote {border-left:3px solid rgba(var(--v-theme-on-surface),.3);background:rgba(var(--v-theme-on-surface),.05);padding:4px 10px;margin-bottom:8px;font-size:.8rem;opacity:.8;}
.qq-media {margin:6px 0;}
.qq-media img,.qq-media video {display:block;max-width:100%;max-height:380px;border-radius:8px;}
.qq-media audio {max-width:100%;}
.qq-media a {display:block;font-size:.8rem;}
.qq-message-label {opacity:.75;}
</style>
