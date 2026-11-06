<script setup lang="ts">
import {computed,nextTick,onBeforeUnmount,ref,watch} from 'vue';
import type {MessageContextAttachment} from '../../../../messageContextStore';
import {qqDisplayParts,qqPartsPreview,qqMessageUrl,qqMediaMime,type QqMessagePart,type QqSelection,type QqHistoryMessage} from '../../../../../ribiwebgui/src/qqMessagePresentation';
import {qqPreviewRead} from '../../../../../ribiwebgui/src/qqPreviewQueue';
import {usePersonaService} from '../persona/personaServiceClient';
import {useI18n} from '../../../../../ribiwebgui/src/i18n/index';
import {userFacingError} from '../../../../../ribiwebgui/src/userFacingError';
const props=defineProps<{text:string;messageId?:string|number;replyToMessageId?:string|number;selection?:QqSelection;names?:Record<string,string>;attachments?:MessageContextAttachment[];active:boolean;readable?:boolean;structuredParts?:QqMessagePart[]}>();
const emit=defineEmits<{image:[{blob:Blob;name:string}];quote:[QqHistoryMessage]}>();
const {fetch}=usePersonaService(),{t}=useI18n();
const parts=computed(()=>{
  const parsed=qqDisplayParts(props.text,props.structuredParts,props.attachments);
  if(props.replyToMessageId!==undefined&&!parsed.some(p=>p.kind==='reply'))parsed.unshift({kind:'reply',id:String(props.replyToMessageId)});
  return parsed;
});
type Media={url:string;mime:string;name:string;blob:Blob};
const root=ref<HTMLElement>(),media=ref(new Map<number,Media>()),errors=ref(new Map<string,string>()),pending=ref(new Set<string>()),quotes=ref(new Map<string,QqHistoryMessage>());
const requests=new Map<string,AbortController>();
let observer:IntersectionObserver|undefined,generation=0,metadata:Promise<{attachments?:{index:number;name:string}[]}>|undefined;
let requestedQuote:string|undefined;
const messageUrl=computed(()=>props.selection&&props.messageId!==undefined?qqMessageUrl(props.selection,props.messageId):undefined);
const identity=computed(()=>JSON.stringify([props.messageId,props.selection,parts.value]));
function clear(){generation++;requestedQuote=undefined;observer?.disconnect();observer=undefined;for(const r of requests.values())r.abort();requests.clear();pending.value.clear();for(const item of media.value.values())URL.revokeObjectURL(item.url);media.value.clear();errors.value.clear();quotes.value.clear();metadata=undefined;}
async function readMessage(url:string,signal:AbortSignal){
  const response=await fetch(url,{signal}),result=await response.json();
  if(!response.ok||result.code!==0)throw Error(result.message||t('QQ 原消息暂不可用'));
  return result.data;
}
async function openMedia(index:number){
  const url=messageUrl.value,key=`media:${index}`;
  if(!url||pending.value.has(key)||media.value.has(index)||!props.active||props.readable===false)return;
  const mine=generation,controller=new AbortController();requests.set(key,controller);pending.value.add(key);errors.value.delete(key);
  try{
    const value=await qqPreviewRead(controller.signal,async()=>{
      const current:Promise<{attachments?:{index:number;name:string}[]}>=metadata??=readMessage(url,controller.signal).catch(error=>{if(mine===generation)metadata=undefined;throw error;});
      const original=await current,attachment=original.attachments?.find((item:{index:number;name:string})=>item.index===index);
      if(!attachment)throw Error(t('此附件暂不可用'));
      const response=await fetch(url.replace('?',`/attachments/${index}?`),{signal:controller.signal});
      if(!response.ok)throw Error(t('此附件暂不可用'));
      const bytes=await response.arrayBuffer(),mime=qqMediaMime(new Uint8Array(bytes));
      return {blob:new Blob([bytes],{type:mime}),mime,name:attachment.name||t('附件')};
    });
    if(controller.signal.aborted||mine!==generation)return;
    media.value.set(index,{...value,url:URL.createObjectURL(value.blob)});
  }catch(error){if(!controller.signal.aborted&&mine===generation)errors.value.set(key,userFacingError(error));}
  finally{if(requests.get(key)===controller){requests.delete(key);pending.value.delete(key);}}
}
async function openQuote(id:string,show=true){
  if(show)requestedQuote=undefined;
  const existing=quotes.value.get(id);if(existing){if(show)emit('quote',existing);return;}
  const url=props.selection&&qqMessageUrl(props.selection,id),key=`quote:${id}`;
  if(!url||!props.active||props.readable===false)return;
  if(show)requestedQuote=id;
  if(pending.value.has(key))return;
  const mine=generation,controller=new AbortController();requests.set(key,controller);pending.value.add(key);errors.value.delete(key);
  try{
    const value=await qqPreviewRead(controller.signal,()=>readMessage(url,controller.signal)) as QqHistoryMessage;
    if(controller.signal.aborted||mine!==generation)return;
    quotes.value.set(id,value);if(requestedQuote===id){requestedQuote=undefined;emit('quote',value);}
  }catch(error){if(!controller.signal.aborted&&mine===generation){if(requestedQuote===id)requestedQuote=undefined;errors.value.set(key,userFacingError(error));}}
  finally{if(requests.get(key)===controller){requests.delete(key);pending.value.delete(key);}}
}
const quoteName=(row:QqHistoryMessage)=>props.names?.[row.sender]||row.senderName||row.sender;
const canReadQuote=(id:string)=>Boolean(props.selection&&qqMessageUrl(props.selection,id)&&props.readable!==false);
const quoteText=(row:QqHistoryMessage)=>qqPartsPreview(qqDisplayParts(row.text,row.parts,row.attachments)).slice(0,160);
async function observe(){
  observer?.disconnect();if(!props.active||props.readable===false||!root.value)return;
  const mine=generation;await nextTick();if(mine!==generation||!root.value)return;
  observer=new IntersectionObserver(entries=>{
    if(mine!==generation)return;
    if(!entries.some(entry=>entry.isIntersecting))return;
    observer?.disconnect();
    for(const part of parts.value){
      if(part.kind==='media'&&part.mediaKind==='image')void openMedia(part.index);
      if(part.kind==='reply')void openQuote(part.id,false);
    }
  });observer.observe(root.value);
}
watch([root,()=>props.active,identity],()=>{clear();void observe();},{flush:'post'});
watch(()=>props.readable,readable=>{if(readable===false){generation++;requestedQuote=undefined;observer?.disconnect();for(const r of requests.values())r.abort();requests.clear();pending.value.clear();metadata=undefined;}else{errors.value.clear();void observe();}});
onBeforeUnmount(clear);
</script>
<template>
  <div ref="root" class="qq-message-content" data-no-i18n>
    <template v-for="(part,index) in parts" :key="index">
      <span v-if="part.kind==='text'">{{ part.text }}</span>
      <span v-else-if="part.kind==='mention'" class="qq-mention">@{{ part.target==='all'?t('全体成员'):names?.[part.target]||part.target }}</span>
      <button v-else-if="part.kind==='reply'" class="qq-quote" :aria-label="t('查看引用消息')" @click="openQuote(part.id)"><strong>{{ quotes.has(part.id)?quoteName(quotes.get(part.id)!):t('引用消息') }}</strong><span>{{ quotes.has(part.id)?quoteText(quotes.get(part.id)!):!canReadQuote(part.id)?t('原消息暂不可用'):errors.get(`quote:${part.id}`)?t('原消息暂不可用，点击重试'):t('正在读取引用消息…') }}</span></button>
      <span v-else-if="part.kind==='label'" class="qq-message-label">[{{ t(part.text) }}]</span>
      <div v-else-if="part.kind==='media'" class="qq-media">
        <template v-if="media.get(part.index)">
          <button v-if="media.get(part.index)!.mime.startsWith('image/')" class="qq-image-thumb" :aria-label="t('查看大图')" @click="emit('image',{blob:media.get(part.index)!.blob,name:media.get(part.index)!.name})"><img :src="media.get(part.index)!.url" :alt="part.name" loading="lazy" /></button>
          <audio v-else-if="media.get(part.index)!.mime.startsWith('audio/')" :src="media.get(part.index)!.url" controls preload="none" />
          <video v-else-if="media.get(part.index)!.mime.startsWith('video/')" :src="media.get(part.index)!.url" controls preload="metadata" />
          <a v-else :href="media.get(part.index)!.url" :download="media.get(part.index)!.name">{{ t('下载') }} · {{ media.get(part.index)!.name }}</a>
        </template>
        <v-btn v-else :class="{'qq-image-placeholder':part.mediaKind==='image'}" variant="tonal" :prepend-icon="part.mediaKind==='image'?'mdi-image':part.mediaKind==='video'?'mdi-video':part.mediaKind==='record'?'mdi-microphone':'mdi-file-document-outline'" :disabled="!messageUrl||readable===false" :loading="pending.has(`media:${part.index}`)" @click="openMedia(part.index)">{{ errors.has(`media:${part.index}`)?t('点击重试'):t(part.name) }}</v-btn>
        <div v-if="errors.get(`media:${part.index}`)" class="text-caption text-medium-emphasis" role="status">{{ t('附件暂时无法读取，可点击重试。') }}</div>
      </div>
    </template>
  </div>
</template>
<style scoped>
.qq-message-content {white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.65;}
.qq-mention {color:rgb(var(--v-theme-secondary));}
.qq-quote {display:block;width:100%;text-align:left;border-left:3px solid rgba(var(--v-theme-on-surface),.3);background:rgba(var(--v-theme-on-surface),.05);padding:5px 9px;margin-bottom:8px;font-size:12px;color:rgba(var(--v-theme-on-surface),.65);}
.qq-quote strong,.qq-quote span {display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.qq-quote strong {font-weight:500;}
.qq-media {margin:6px 0;}
.qq-media video {display:block;max-width:100%;max-height:320px;border-radius:8px;}
.qq-media audio {max-width:100%;}
.qq-media a {display:block;font-size:12px;}
.qq-image-thumb,.qq-image-placeholder {display:block;width:260px!important;max-width:100%;height:180px!important;border-radius:6px;overflow:hidden;background:rgba(var(--v-theme-on-surface),.04);}
.qq-image-thumb img {display:block;width:100%;height:100%;object-fit:contain;}
.qq-image-thumb:focus-visible,.qq-quote:focus-visible {outline:2px solid rgb(var(--v-theme-secondary));outline-offset:2px;}
.qq-message-label {opacity:.75;}
</style>
