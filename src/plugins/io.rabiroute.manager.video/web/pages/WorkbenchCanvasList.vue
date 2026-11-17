<script setup lang="ts">
import {computed,onBeforeUnmount,onMounted,ref,watch} from "vue";
import {visibleList} from "./workbenchEditor";
const props=defineProps<{rows:{id:string;name:string;nodeCount:number}[];disabled:boolean}>();
const emit=defineEmits<{open:[id:string];copy:[row:{id:string;name:string}];more:[]}>();
const scroller=ref<HTMLElement>(),top=ref(0),height=ref(480);
const range=computed(()=>visibleList(props.rows.length,top.value,height.value));
const visible=computed(()=>props.rows.slice(range.value.start,range.value.end));
let observer:ResizeObserver|undefined;
function reset(){top.value=0;if(scroller.value)scroller.value.scrollTop=0;}
watch(()=>props.rows[0]?.id,reset);
onMounted(()=>{observer=new ResizeObserver(()=>{height.value=scroller.value?.clientHeight||480;});if(scroller.value)observer.observe(scroller.value);});
onBeforeUnmount(()=>observer?.disconnect());
defineExpose({reset});
</script>
<template><div ref="scroller" class="canvas-list" role="list" aria-label="画布列表" tabindex="0" @scroll="top=($event.target as HTMLElement).scrollTop"><div :style="{height:range.top+'px'}" aria-hidden="true"/><article v-for="row in visible" :key="row.id" role="listitem"><button class="open-canvas" :disabled="disabled" @click="emit('open',row.id)"><span class="canvas-symbol" aria-hidden="true">▦</span><span><strong>{{row.name}}</strong><small>{{row.nodeCount}} 个节点</small></span></button><button class="copy-canvas" :disabled="disabled" @click="emit('copy',row)">复制</button></article><div :style="{height:range.bottom+'px'}" aria-hidden="true"/><p v-if="!rows.length" class="empty-list">暂无画布</p></div></template>
<style scoped>.canvas-list{height:min(56vh,560px);min-height:240px;overflow:auto;overscroll-behavior:contain;border:1px solid var(--wb-border);border-radius:10px;margin:0 24px}.canvas-list article{height:80px;display:flex;align-items:center;padding:0 20px;border-bottom:1px solid var(--wb-border)}.open-canvas{display:flex;align-items:center;gap:16px;flex:1;min-width:0;text-align:left;height:100%;color:inherit}.open-canvas strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:550}.open-canvas small{display:block;color:var(--wb-muted);margin-top:5px}.canvas-symbol{font-size:26px;color:var(--wb-accent);background:#233b3b;border-radius:7px;padding:2px 11px}.copy-canvas{padding:8px 14px;color:var(--wb-muted);border-radius:5px}.copy-canvas:hover{background:var(--wb-input);color:var(--wb-text)}button:focus-visible{outline:2px solid var(--wb-accent);outline-offset:2px}.empty-list{padding:40px;color:var(--wb-muted);text-align:center}</style>
