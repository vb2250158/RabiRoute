<script setup lang="ts">
import {computed,ref} from 'vue';
import {pluginCatalogStore} from '../pluginCatalogStore';
import {agentAvatarPresentation} from '../agentAdapters/agentAvatarPresentation';
import {useI18n} from '../i18n';
const props=withDefaults(defineProps<{provider?:string;kind?:'agent'|'user';size?:number}>(),{kind:'agent',size:36});
const {t}=useI18n();
const failed=ref('');
const imageElement=ref<HTMLImageElement>();
const presentation=computed(()=>agentAvatarPresentation(props.provider,pluginCatalogStore.agentAdapters.value));
const url=computed(()=>props.kind==='agent'?presentation.value.url:undefined);
const label=computed(()=>props.kind==='user'?t('用户'):presentation.value.label||t('Agent'));
function imageFailed(event:Event){
  if(event.currentTarget!==imageElement.value)return;
  const source=(event.currentTarget as HTMLImageElement).getAttribute('src');
  if(source&&source===url.value)failed.value=source;
}
</script>
<template>
  <span class="agent-avatar" :class="{'agent-avatar-artwork':url&&failed!==url}" role="img" :aria-label="label" :title="label" :style="{width:`${size}px`,height:`${size}px`}">
    <img v-if="url&&failed!==url" ref="imageElement" :key="url" :src="url" alt="" loading="lazy" decoding="async" @error="imageFailed" />
    <v-icon v-else :icon="kind==='user'?'mdi-account-outline':presentation.icon" :size="Math.round(size*.6)" />
  </span>
</template>
<style scoped>
.agent-avatar{display:inline-flex;align-items:center;justify-content:center;flex:none;box-sizing:border-box;padding:3px;border-radius:9px;background:rgba(var(--v-theme-on-surface),.06);color:rgb(var(--v-theme-on-surface));overflow:hidden;}
.agent-avatar img{display:block;width:100%;height:100%;object-fit:contain;}
.agent-avatar-artwork{background:#fff;}
</style>
