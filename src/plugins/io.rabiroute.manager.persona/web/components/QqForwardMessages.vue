<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { QqSelection } from '../../../../../ribiwebgui/src/qqMessagePresentation';
import type { QqForwardPage, QqForwardNode } from '../persona/qqForwardPresentation';
import { qqForwardUrl } from '../persona/qqForwardPresentation';
import { qqPreviewRead } from '../../../../../ribiwebgui/src/qqPreviewQueue';
import { usePersonaService } from '../persona/personaServiceClient';
import { useI18n } from '../../../../../ribiwebgui/src/i18n/index';
import { userFacingError } from '../../../../../ribiwebgui/src/userFacingError';
import QqAvatar from './QqAvatar.vue';
import QqMessageContent from './QqMessageContent.vue';
import ChatMessageBody from './ChatMessageBody.vue';
const props=defineProps<{selection:QqSelection;messageId:string|number;initialPath:string;active:boolean;readable?:boolean}>();
const emit=defineEmits<{close:[];image:[{blob:Blob;name:string}]}>();
const {fetch}=usePersonaService(),{t,locale}=useI18n();
const frames=ref<Array<{path:string;offset:number}>>([]),page=ref<QqForwardPage>(),loading=ref(false),error=ref('');
const expanded=ref(new Set<number>());
const path=computed(()=>frames.value.at(-1)?.path??props.initialPath);
const offset=computed(()=>frames.value.at(-1)?.offset??0);
let request:AbortController|undefined,generation=0;
function cancel(){generation++;request?.abort();request=undefined;loading.value=false;}
async function load(){
  cancel();page.value=undefined;expanded.value.clear();error.value='';
  if(!props.active||props.readable===false)return;
  const url=qqForwardUrl(props.selection,props.messageId,path.value);
  if(!url){error.value=t('此转发暂时无法展开');return;}
  const mine=generation,controller=new AbortController();request=controller;loading.value=true;
  try{
    const data=await qqPreviewRead(controller.signal,async()=>{
      const response=await fetch(url+'&'+new URLSearchParams({offset:String(offset.value),limit:'100'}),{signal:controller.signal});
      const result=await response.json();
      if(!response.ok||result.code!==0)throw Error(result.message||t('转发内容暂时无法读取'));
      return result.data as QqForwardPage;
    });
    if(controller.signal.aborted||mine!==generation)return;
    page.value=data;
  }catch(cause){if(!controller.signal.aborted&&mine===generation)error.value=userFacingError(cause);}
  finally{if(request===controller){request=undefined;loading.value=false;}}
}
function navigate(next:string){if(!qqForwardUrl(props.selection,props.messageId,next))return;frames.value.push({path:next,offset:0});}
function changePage(next:number){if(loading.value||!Number.isSafeInteger(next)||next<0)return;const frame=frames.value.at(-1);if(frame)frame.offset=next;}
function back(){if(frames.value.length>1)frames.value.pop();}
function toggle(index:number){if(expanded.value.has(index))expanded.value.delete(index);else expanded.value.add(index);}
function sender(row:QqForwardNode){return row.senderName||row.sender||t('未知发送者');}
function time(row:QqForwardNode){if(!row.time)return '';const date=new Date(row.time*1000);return Number.isFinite(date.getTime())?date.toLocaleString(locale.value):'';}
const context=computed(()=>JSON.stringify([props.selection,props.messageId,props.initialPath]));
watch(context,()=>{frames.value=[{path:props.initialPath,offset:0}];},{immediate:true});
watch([context,path,offset,()=>props.active,()=>props.readable],()=>{void load();},{immediate:true});
function close(){cancel();emit('close');}
onBeforeUnmount(cancel);
</script>
<template>
  <v-dialog :model-value="true" max-width="820" scrollable :aria-label="t('合并转发')" @update:model-value="value=>{if(!value)close();}">
    <v-card class="qq-forward-dialog">
      <v-card-title class="qq-forward-heading">
        <v-btn v-if="frames.length>1" icon="mdi-arrow-left" variant="text" :aria-label="t('返回上一层转发')" @click="back" />
        <div><span>{{ t('合并转发') }}</span><div v-if="page" class="text-caption text-medium-emphasis">{{ t('聊天记录') }} · {{ page.total }} {{ t('条消息') }}</div></div>
        <v-spacer /><v-btn icon="mdi-close" variant="text" :aria-label="t('关闭')" @click="close" />
      </v-card-title>
      <v-card-text class="qq-forward-body">
        <v-progress-linear v-if="loading" indeterminate :aria-label="t('正在读取转发内容')" />
        <div v-if="error" class="qq-forward-error" role="status"><span>{{ error }}</span><v-btn variant="text" @click="load">{{ t('点击重试') }}</v-btn></div>
        <v-alert v-if="page?.truncated" type="info" variant="tonal" density="compact" class="mb-3">{{ t('部分转发内容未能显示，已读取的消息仍可查看。') }}</v-alert>
        <v-virtual-scroll v-if="page?.entries.length" :key="path" :items="page.entries" :height="520" :item-height="100" class="qq-forward-nodes">
          <template #default="{item:row}">
            <div :key="row.nodeIndex" class="qq-forward-node">
              <QqAvatar :id="row.sender" :name="sender(row)" :size="32" />
              <section class="qq-forward-node-content">
                <header><strong data-no-i18n>{{ sender(row) }}</strong><time v-if="time(row)">{{ time(row) }}</time></header>
                <ChatMessageBody :expanded="expanded.has(row.nodeIndex)" @toggle="toggle(row.nodeIndex)">
                  <QqMessageContent :text="row.text" :message-id="messageId" :structured-parts="row.parts" :attachments="row.attachments" :selection="selection" :forward-reference="{messageId,path,nodeIndex:row.nodeIndex}" :active="active&&!loading" :readable="readable" @forward="navigate" @image="emit('image',$event)" />
                </ChatMessageBody>
              </section>
            </div>
          </template>
        </v-virtual-scroll>
        <div v-else-if="!loading&&!error" class="text-body-2 text-medium-emphasis">{{ t('转发内容暂时无法读取') }}</div>
        <div v-if="page" class="qq-forward-pagination">
          <v-btn variant="text" :disabled="loading||page.offset===0" @click="changePage(Math.max(0,page.offset-100))">{{ t('上一页') }}</v-btn>
          <span class="text-caption text-medium-emphasis">{{ page.offset+1 }}–{{ Math.min(page.offset+100,page.total) }} / {{ page.total }}</span>
          <v-btn variant="text" :disabled="loading||page.nextOffset===null" @click="changePage(page.nextOffset!)">{{ t('下一页') }}</v-btn>
        </div>
      </v-card-text>
    </v-card>
  </v-dialog>
</template>
<style scoped>
.qq-forward-heading{display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--rr-border-faint);}
.qq-forward-body{padding:16px!important;}
.qq-forward-nodes{max-height:65dvh;overflow-x:hidden;}
.qq-forward-node{display:flex;align-items:flex-start;gap:10px;margin-bottom:20px;}
.qq-forward-node-content{min-width:0;flex:1;padding:0 6px 0 0;}
.qq-forward-node-content header{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 12px;margin-bottom:5px;font-size:12px;color:var(--rr-muted);}
.qq-forward-node-content strong{font-weight:500;}
.qq-forward-node-content time{font-size:11px;}
.qq-forward-pagination{display:flex;align-items:center;justify-content:space-between;gap:8px;border-top:1px solid var(--rr-border-faint);padding-top:8px;}
.qq-forward-error{display:flex;align-items:center;gap:8px;color:var(--rr-muted);}
@media(max-width:600px){.qq-forward-body{padding:12px!important;}.qq-forward-node{gap:8px;}}
</style>
