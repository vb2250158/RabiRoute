<script setup lang="ts">
import {onBeforeUnmount,ref,watch} from 'vue';
import {useI18n} from '../../../../../ribiwebgui/src/i18n/index';
const props=defineProps<{image:{blob:Blob;name:string}}>();
defineEmits<{close:[]}>();
const {t}=useI18n(),url=ref('');
watch(()=>props.image,image=>{if(url.value)URL.revokeObjectURL(url.value);url.value=URL.createObjectURL(image.blob);},{immediate:true});
onBeforeUnmount(()=>URL.revokeObjectURL(url.value));
</script>
<template><v-dialog :model-value="true" max-width="1100" @update:model-value="!$event&&$emit('close')"><v-card><v-card-actions><span class="text-caption" data-no-i18n>{{ image.name }}</span><v-spacer /><v-btn icon="mdi-close" :aria-label="t('关闭')" @click="$emit('close')" /></v-card-actions><img :src="url" :alt="image.name" class="qq-full-image" /><v-card-actions><v-spacer /><v-btn :href="url" :download="image.name" prepend-icon="mdi-download">{{ t('下载') }}</v-btn></v-card-actions></v-card></v-dialog></template>
<style scoped>.qq-full-image {display:block;max-width:100%;max-height:78dvh;object-fit:contain;margin:0 auto;}</style>
