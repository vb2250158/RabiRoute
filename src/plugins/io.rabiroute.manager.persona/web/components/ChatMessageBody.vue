<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from '../../../../../ribiwebgui/src/i18n/index';
const props=defineProps<{expanded:boolean;truncated?:boolean;loading?:boolean}>();
defineEmits<{toggle:[]}>();
const {t}=useI18n();
const content=ref<HTMLElement>(),height=ref(0),limit=ref(288);
const collapsible=computed(()=>Boolean(props.truncated)||height.value>limit.value+1);
let observer:ResizeObserver|undefined,frame=0;
function measure(){
  cancelAnimationFrame(frame);
  frame=requestAnimationFrame(()=>{limit.value=Math.max(120,Math.min(288,window.innerHeight*.38));height.value=content.value?.getBoundingClientRect().height??0;});
}
onMounted(()=>{measure();observer=new ResizeObserver(measure);if(content.value)observer.observe(content.value);window.addEventListener('resize',measure);});
onBeforeUnmount(()=>{observer?.disconnect();cancelAnimationFrame(frame);window.removeEventListener('resize',measure);});
</script>
<template>
  <div class="chat-message-body" :class="{'chat-message-collapsed':!expanded}" :style="{'--chat-collapse-height':`${limit}px`}">
    <div class="chat-body-viewport"><div ref="content" class="chat-body-content"><slot /></div></div>
    <v-btn v-if="collapsible" class="chat-body-toggle" variant="text" size="small" :loading="loading" :aria-expanded="expanded" @click="$emit('toggle')">{{t(expanded?'收起':'展开全文')}}</v-btn>
  </div>
</template>
<style scoped>
.chat-message-body,.chat-body-content{min-width:0;}
.chat-message-collapsed>.chat-body-viewport{max-height:var(--chat-collapse-height);overflow:hidden;}
.chat-body-toggle{margin-top:6px;padding-inline:0;min-width:0;color:rgb(var(--v-theme-secondary));}
</style>
