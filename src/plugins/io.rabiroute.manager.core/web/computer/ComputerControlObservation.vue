<script setup lang="ts">
import { useI18n } from "../../../../../ribiwebgui/src/i18n/index";
import { computed, ref, watch } from "vue";
import { computerRequestSchema } from "@shared/agentInteractiveProtocol";
import type { ComputerFieldSchema } from "./computerControlPresentation";
import ComputerControlSchemaFields from "./ComputerControlSchemaFields.vue";
const { t } = useI18n();
const props=defineProps<{windows:Record<string,unknown>[];capabilities?:string[];disabled?:boolean;busy?:boolean}>();const emit=defineEmits<{submit:[Record<string,unknown>]; "source-change":[]}>();
const source=ref("desktop");const selected=ref("");const parameters=ref<Record<string,unknown>>({});
const requestSchema=computerRequestSchema as {anyOf:Array<{properties:Record<string,ComputerFieldSchema>&{action:{const:string}}}>};
const schema=computed(()=>({type:"object",properties:{maxWidth:requestSchema.anyOf.find(branch=>branch.properties.action.const==="screen.capture")?.properties.maxWidth || {}}} as ComputerFieldSchema));
watch([source,selected],()=>emit("source-change"));
function capture(){const window=props.windows.find(item=>item.windowId===selected.value);emit("submit",{action:"screen.capture",...parameters.value,...(source.value==="window"&&window?{windowId:window.windowId,pid:window.pid}:{})});}
</script>
<template><div class="computer-observation"><v-select v-model="source" :label="t('观察来源')" :items="[{title:t('桌面'),value:'desktop'},{title:t('指定窗口'),value:'window'}]" :disabled="disabled" density="compact" /><template v-if="source==='window'"><v-btn :disabled="disabled || capabilities && !capabilities.includes('windows')" :loading="busy" variant="text" @click="emit('submit',{action:'windows.list'})">{{ t('按需查询窗口') }}</v-btn><v-select v-model="selected" :items="windows.map(window=>({title:String(window.title || t('未命名窗口')),value:String(window.windowId)}))" :label="t('目标窗口')" :disabled="disabled" density="compact" /></template><ComputerControlSchemaFields v-model="parameters" :schema="schema" :disabled="disabled" /><v-btn :disabled="disabled || capabilities && !capabilities.includes('screenshots') || source==='window' && !windows.some(window=>window.windowId===selected)" :loading="busy" variant="tonal" @click="capture">{{ t('刷新画面') }}</v-btn></div></template>
<style scoped>.computer-observation{display:grid;gap:10px;padding:12px 0;min-width:0;}</style>
