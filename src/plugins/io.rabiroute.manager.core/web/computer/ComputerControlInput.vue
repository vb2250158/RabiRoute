<script setup lang="ts">
import { useI18n } from "../../../../../ribiwebgui/src/i18n/index";
import { computed, ref, watch } from "vue";
import { computerInputActionSchema } from "@shared/agentInteractiveProtocol";
import { cloneComputerValue, schemaDefault, type ComputerFieldSchema } from "./computerControlPresentation";
import ComputerControlSchemaFields from "./ComputerControlSchemaFields.vue";
const { t } = useI18n();
const props=defineProps<{sessionId:string;disabled?:boolean;busy?:boolean;requestId?:string;}>();
const emit=defineEmits<{submit:[Record<string,unknown>]}>();
type Branch=ComputerFieldSchema & {properties:Record<string,ComputerFieldSchema>&{type:{const:string}}};
const branches=(computerInputActionSchema as {anyOf:Branch[]}).anyOf;
const selected=ref(branches[0]?.properties.type.const || "");const value=ref<Record<string,unknown>>({});const queued=ref<Record<string,unknown>[]>([]);const captureAfter=ref(false);const invalid=ref(new Set<string>());
const labels:Record<string,string>={move:"移动鼠标",click:"点击 / 双击 / 右键",scroll:"滚动",drag:"拖拽",text:"输入文字",key:"组合键"};
const schema=computed(()=>{const branch=branches.find(item=>item.properties.type.const===selected.value);return {...branch,properties:Object.fromEntries(Object.entries(branch?.properties || {}).filter(([key])=>key!=="type"))} as ComputerFieldSchema;});
watch(selected,()=>{value.value=(schemaDefault(schema.value)||{}) as Record<string,unknown>;invalid.value.clear();},{immediate:true});
function append(){queued.value.push({type:selected.value,...cloneComputerValue(value.value)});}
function execute(){emit("submit",{action:"input.execute",controlSessionId:props.sessionId,actions:queued.value,captureAfter:captureAfter.value});}
</script>
<template><div class="computer-input"><p>{{ t('先进入控制，再提交一个有序动作批次。坐标按当前来源画面的像素空间解释；已注入与应用结果分别确认。') }}</p><v-select v-model="selected" :items="branches.map(branch=>({value:branch.properties.type.const,title:t(labels[branch.properties.type.const])}))" :label="t('本次输入')" :disabled="disabled" density="compact" /><ComputerControlSchemaFields :key="selected" v-model="value" :schema="schema" :disabled="disabled" @validity="(path,valid)=>valid?invalid.delete(path):invalid.add(path)" /><v-btn :disabled="disabled || !!invalid.size" variant="text" @click="append">{{ t('加入动作批次') }}</v-btn><ol v-if="queued.length"><li v-for="(item,index) in queued" :key="index">{{ t(labels[String(item.type)]) }}<v-btn size="x-small" variant="text" @click="queued.splice(index,1)">{{ t('移除') }}</v-btn></li></ol><v-checkbox v-model="captureAfter" :label="t('操作后刷新画面（本次请求）')" :disabled="disabled" hide-details /><div class="input-buttons"><v-btn :disabled="disabled || !sessionId || !queued.length" :loading="busy" variant="tonal" @click="execute">{{ t('执行所选输入') }}</v-btn><v-btn :disabled="!requestId" variant="text" @click="emit('submit',{action:'input.status',requestId})">{{ t('查询原输入') }}</v-btn><v-btn :disabled="!requestId" variant="text" @click="emit('submit',{action:'input.cancel',requestId})">{{ t('取消本次输入') }}</v-btn></div></div></template>
<style scoped>.computer-input{display:grid;gap:10px;padding:12px 0;min-width:0;}.computer-input p{font-size:.85rem;color:var(--rr-muted);}.input-buttons{display:flex;gap:8px;flex-wrap:wrap;}.computer-input li{line-height:2;}</style>
