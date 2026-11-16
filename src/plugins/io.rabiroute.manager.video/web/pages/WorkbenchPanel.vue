<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { browserUuid } from "../../../../../ribiwebgui/src/browserUuid";
import { useVideoCanvas } from "./useVideoCanvas";
import WorkbenchRunPanel from "./WorkbenchRunPanel.vue";
type Node = { id:string; kind:string; title?:string; enabled?:boolean; gate?:boolean; optional?:boolean; config:Record<string,unknown>; layout?:{x:number;y:number}; inputs?:unknown[]; requirements?:unknown[] };
type Edge = { id:string; from:string; to:string; fromPort:string; toPort:string; condition:string; allowSkip?:boolean };
type Canvas = { version:number; id:string; name:string; revision:number; workspaceBindingKey:string; variables:unknown[]; graph:{nodes:Node[];edges:Edge[];groups:{id:string;name?:string;nodeIds:string[]}[]}; [key:string]:unknown };
const props = defineProps<{projectId:string}>();
const emit = defineEmits<{back:[]; media:[canvasId:string]}>();
const project = ref<{title:string;revision:number;defaultCanvasId:string}>();
const rows = ref<{id:string;name:string;revision:number;nodeCount:number}[]>([]), cursor = ref<string|null>(null), search = ref("");
const value = ref<Canvas>(), error = ref(""), busy = ref(false), dirty = ref(false), selected = ref("");
const definition = ref<{capabilities:Record<string,{label:string}>,nodeStates:Record<string,{label:string}>}>();
const editor = ref(""), variables = ref("[]"), edgeFrom = ref(""), edgeTo = ref(""), edgeCondition = ref("success");
const pastedFolder = ref("");
const canvas = useVideoCanvas(), {viewport,transform,grid} = canvas;
const base = computed(()=>`/api/video/v2/projects/${encodeURIComponent(props.projectId)}`);
const activeNode = computed(()=>value.value?.graph.nodes.find(node=>node.id===selected.value));
async function api<T>(suffix:string,method="GET",body?:unknown):Promise<T> {
  const response=await fetch(base.value+suffix,{method,headers:{"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const result=await response.json(); if(!response.ok) throw new Error(result.message||"工作台请求失败。"); return result;
}
async function action(fn:()=>Promise<unknown>) { if(busy.value)return; busy.value=true;error.value="";try{await fn();}catch(cause){error.value=cause instanceof Error?cause.message:String(cause);}finally{busy.value=false;} }
function route(id?:string) { const url=new URL(location.href); if(id){if(url.searchParams.get("canvas")!==id)url.searchParams.delete("run");url.searchParams.set("canvas",id);url.searchParams.delete("view");}else{url.searchParams.delete("run");url.searchParams.delete("canvas");url.searchParams.set("view","canvases");}history.replaceState(null,"",url); }
async function list(append=false) {
  const query=new URLSearchParams({limit:"50",search:search.value});if(append&&cursor.value)query.set("cursor",cursor.value);
  const page=await api<{canvases:typeof rows.value;nextCursor:string|null}>(`/canvases?${query}`);
  rows.value=append?[...new Map([...rows.value,...page.canvases].map(row=>[row.id,row])).values()]:page.canvases;
  cursor.value=page.nextCursor;
}
async function open(id:string) {
  if(dirty.value)throw new Error("请先保存或导出当前编辑，再切换画布。");
  value.value=await api<Canvas>(`/canvases/${id}`);selected.value="";variables.value=JSON.stringify(value.value.variables,null,2);
  canvas.positions.value=Object.fromEntries(value.value.graph.nodes.map(node=>[node.id,node.layout||{x:0,y:0}]));route(id);await nextTick();canvas.fit();
}
async function create() { const record=await api<Canvas>("/canvases","POST",{id:browserUuid()}); await open(record.id); }
async function importFile(event:Event) {const input=event.target as HTMLInputElement,file=input.files?.[0];input.value="";if(!file)return;if(file.size>16*1024*1024)throw new Error("导入定义最大 16 MB。");const record=await api<Canvas>("/canvases/import","POST",{id:browserUuid(),source:JSON.parse(await file.text())});await open(record.id);}
function select(node:Node) {
  if(selected.value===node.id)return;
  applyNode();
  selected.value=node.id;
  editor.value=JSON.stringify({config:node.config,inputs:node.inputs||[],requirements:node.requirements||[]},null,2);
}
function parseDraft(text:string,label:string) {
  try{return JSON.parse(text);}catch{throw new Error(`${label} JSON 无效，请修正后重试。当前草稿已保留。`);}
}
function applyNode() {
  const node=activeNode.value;
  if(!node)return;
  const parsed=parseDraft(editor.value,"节点参数");
  if(!parsed||!parsed.config||typeof parsed.config!=="object"||Array.isArray(parsed.config))throw new Error("节点参数需要 config 对象。当前草稿已保留。");
  if(JSON.stringify(parsed)===JSON.stringify({config:node.config,inputs:node.inputs||[],requirements:node.requirements||[]}))return;
  node.config=parsed.config;node.inputs=parsed.inputs;node.requirements=parsed.requirements;
  dirty.value=true;
}
function add(kind:string) {
  if(!value.value)return;
  applyNode();
  const id=browserUuid();canvas.add(id);
  const config=kind==="command"?{toolKey:"",argv:[]}:kind==="agent"?{target:{},briefRef:""}:kind==="generate"?{command:{}}:kind==="asset"?{mediaKind:"text",ref:""}:{};
  const node={id,kind,title:definition.value?.capabilities[kind]?.label||kind,config,layout:canvas.positions.value[id]};value.value.graph.nodes.push(node);select(node);dirty.value=true;
}
function connect() {
  if(!value.value)return;value.value.graph.edges.push({id:browserUuid(),from:edgeFrom.value,to:edgeTo.value,fromPort:"control",toPort:"control",condition:edgeCondition.value});dirty.value=true;
}
function remove() {
  if(!value.value)return;const graph=value.value.graph;graph.nodes=graph.nodes.filter(node=>node.id!==selected.value);graph.edges=graph.edges.filter(edge=>edge.from!==selected.value&&edge.to!==selected.value);for(const group of graph.groups)group.nodeIds=group.nodeIds.filter(id=>id!==selected.value);selected.value="";dirty.value=true;
}
function draftPayload() {
  applyNode();
  const payload=JSON.parse(JSON.stringify(value.value)) as Canvas;
  payload.variables=parseDraft(variables.value,"变量");
  for(const node of payload.graph.nodes)node.layout=canvas.positions.value[node.id]||node.layout;
  return payload;
}
function draftSnapshot() {
  return JSON.stringify([value.value,editor.value,variables.value,canvas.positions.value]);
}
async function save() {
  if(!value.value)return;
  const payload=draftPayload(),submitted=draftSnapshot();
  const saved=await api<Canvas>(`/canvases/${payload.id}`,"PUT",payload);
  if(draftSnapshot()===submitted){value.value=saved;dirty.value=false;}
  else{value.value.revision=saved.revision;dirty.value=true;}
}
async function showList() {if(dirty.value)throw new Error("请先保存或导出当前编辑。");value.value=undefined;rows.value=[];route();await list();}
async function copy(row:{id:string;name:string}) {
  const copied=await api<Canvas>("/canvases/copy","POST",{id:browserUuid(),requestId:browserUuid(),sourceCanvasId:row.id,name:`${row.name} 副本`});await open(copied.id);
}
async function registerFolder() {const record=await api<Canvas>("/canvases/copy","POST",{id:browserUuid(),requestId:browserUuid(),folderName:pastedFolder.value});await open(record.id);}
async function setDefault() {if(!value.value||!project.value)return;project.value=await api("","PUT",{revision:project.value.revision,defaultCanvasId:value.value.id});}
async function exportDraft() {
  if(!value.value)return;
  const blob=new Blob([JSON.stringify(draftPayload(),null,2)],{type:"application/json"}),url=URL.createObjectURL(blob),link=document.createElement("a");link.href=url;link.download=`${value.value.id}.json`;link.click();URL.revokeObjectURL(url);
}
function finishGesture(event:PointerEvent){canvas.end(event);if(value.value?.graph.nodes.some(node=>JSON.stringify(node.layout||{x:0,y:0})!==JSON.stringify(canvas.positions.value[node.id]||{x:0,y:0})))dirty.value=true;}
function point(id:string){const p=canvas.positions.value[id]||{x:0,y:0};return{x:p.x+160,y:p.y+62};}
onMounted(()=>void action(async()=>{
  const response=await fetch("/api/video/v2/definition");if(!response.ok)throw new Error("无法读取节点定义。");definition.value=await response.json();
  project.value=await api(""); const params=new URL(location.href).searchParams;
  if(params.get("view")==="canvases")await list();else await open(params.get("canvas")||project.value!.defaultCanvasId);
}));
</script>
<template>
  <section class="workbench">
    <header><v-btn variant="text" @click="value ? action(showList) : emit('back')">{{ value?'画布列表':'我的项目' }}</v-btn><strong>{{project?.title}}</strong><input v-if="value" v-model="value.name" aria-label="画布名称" @input="dirty=true"/><span v-if="dirty">未保存</span><v-spacer/><template v-if="value"><v-btn :disabled="busy" @click="action(exportDraft)">导出定义</v-btn><v-btn :disabled="busy" @click="action(setDefault)">设为默认</v-btn><v-btn :disabled="busy||dirty" @click="emit('media',value.id)">媒体编辑</v-btn><v-btn :disabled="busy" color="primary" @click="action(save)">保存画布</v-btn></template><v-btn v-else :disabled="busy" color="primary" @click="action(create)">新建画布</v-btn></header>
    <v-alert v-if="error" type="error" variant="tonal">{{error}}</v-alert>
    <div v-if="!value" class="list-tools"><label>导入工作流定义 <input type="file" accept="application/json,.json" :disabled="busy" @change="event=>action(()=>importFile(event))"/></label></div>
    <v-alert v-if="value?.importReport" type="info" variant="tonal">导入报告：{{JSON.stringify(value.importReport)}}</v-alert>
    <details v-if="value?.externalDependencies" class="list-tools"><summary>外部依赖</summary><pre>{{JSON.stringify(value.externalDependencies,null,2)}}</pre></details>
    <template v-if="!value"><div class="list-tools"><v-text-field v-model="search" label="搜索画布" hide-details @keyup.enter="action(()=>list())"/><v-btn @click="action(()=>list())">搜索</v-btn></div><div class="canvas-list"><article v-for="row in rows" :key="row.id"><button @click="action(()=>open(row.id))"><strong>{{row.name}}</strong><small>{{row.nodeCount}} 个节点</small></button><v-btn variant="text" @click="action(()=>copy(row))">复制</v-btn></article></div><v-btn v-if="cursor" :disabled="busy" @click="action(()=>list(true))">加载下一页</v-btn><div class="list-tools"><v-text-field v-model="pastedFolder" label="已粘贴到 canvases/ 的文件夹名" hide-details/><v-btn :disabled="!pastedFolder||busy" @click="action(registerFolder)">登记副本</v-btn></div></template>
    <div v-else class="editor-layout">
      <aside><label>执行目录绑定<input v-model="value.workspaceBindingKey" @input="dirty=true"/></label><label>变量<textarea v-model="variables" rows="6" @input="dirty=true"/></label><h3>添加节点</h3><v-btn v-for="(entry,kind) in definition?.capabilities" :key="kind" size="small" variant="outlined" @click="action(async()=>add(String(kind)))">{{entry.label}}</v-btn><h3>连接</h3><select v-model="edgeFrom" aria-label="前置节点"><option value="">选择前置</option><option v-for="node in value.graph.nodes.filter(n=>n.kind!=='asset')" :key="node.id" :value="node.id">{{node.title}}</option></select><select v-model="edgeTo" aria-label="后继节点"><option value="">选择后继</option><option v-for="node in value.graph.nodes.filter(n=>n.kind!=='asset')" :key="node.id" :value="node.id">{{node.title}}</option></select><select v-model="edgeCondition" aria-label="连接条件"><option value="success">成功后</option><option value="completed">结束后</option></select><v-btn :disabled="!edgeFrom||!edgeTo" @click="connect">连接</v-btn><div v-for="edge in value.graph.edges" :key="edge.id" class="edge-row"><small>{{value.graph.nodes.find(n=>n.id===edge.from)?.title}} → {{value.graph.nodes.find(n=>n.id===edge.to)?.title}} · {{edge.condition}}</small><button aria-label="移除连接" @click="value.graph.edges=value.graph.edges.filter(e=>e.id!==edge.id);dirty=true">×</button></div></aside>
      <div ref="viewport" class="graph-viewport" :style="grid" @pointerdown="canvas.backgroundDown" @pointermove="canvas.move" @pointerup="finishGesture($event)" @pointercancel="canvas.end" @wheel.prevent="canvas.wheel"><div class="graph-world" :style="transform"><svg class="edges"><line v-for="edge in value.graph.edges" :key="edge.id" :x1="point(edge.from).x" :y1="point(edge.from).y" :x2="point(edge.to).x" :y2="point(edge.to).y"/></svg><article v-for="node in value.graph.nodes" :key="node.id" class="canvas-object flow-node" :class="{selected:node.id===selected}" :style="canvas.position(node.id)" @click.stop="action(async()=>select(node))"><header @pointerdown.stop="canvas.begin($event,node.id)"><span>{{definition?.capabilities[node.kind]?.label}}</span><strong>{{node.title}}</strong></header><small>{{node.gate?'门禁 · ':''}}{{node.enabled===false?'已禁用':'已启用'}}</small></article></div></div>
      <aside v-if="activeNode"><label>节点名称<input v-model="activeNode.title" @input="dirty=true"/></label><label><input v-model="activeNode.enabled" type="checkbox" :true-value="true" :false-value="false" @change="dirty=true"/>启用</label><label><input v-model="activeNode.gate" type="checkbox" @change="dirty=true"/>门禁</label><label><input v-model="activeNode.optional" type="checkbox" @change="dirty=true"/>可选节点</label><label>参数、输入与产物要求<textarea v-model="editor" rows="23" spellcheck="false" @input="dirty=true"/></label><v-btn @click="action(async()=>applyNode())">应用参数</v-btn><v-btn color="error" variant="text" @click="remove">移除节点</v-btn></aside>
    </div>
    <WorkbenchRunPanel v-if="value" :key="value.id" :project-id="projectId" :canvas-id="value.id" :revision="value.revision" :dirty="dirty||busy" :states="definition?.nodeStates"/>
  </section>
</template>
<style scoped>
.workbench{min-height:85vh;background:#11171d;color:#e7edf3}.workbench>header{display:flex;align-items:center;gap:12px;padding:16px;border-bottom:1px solid #34404b}.workbench input,.workbench select,.workbench textarea{color:inherit;background:#1e2933;border:1px solid #445563;border-radius:6px;padding:8px;width:100%;font:inherit}.workbench>header input{max-width:240px}.list-tools{display:flex;align-items:center;gap:12px;max-width:760px;padding:20px}.canvas-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px;padding:20px}.canvas-list article{padding:16px;border:1px solid #34404b;border-radius:10px;display:flex;align-items:center;justify-content:space-between}.canvas-list button{text-align:left}.canvas-list small{display:block;color:#a4b5c6}.editor-layout{display:flex;height:calc(100vh - 170px);min-height:600px}.editor-layout aside{width:260px;flex-shrink:0;overflow:auto;padding:16px;border-right:1px solid #34404b}.editor-layout label{display:block;margin-bottom:16px}.editor-layout input[type=checkbox]{width:auto;margin-right:8px}.editor-layout h3{margin:18px 0 10px;font-size:15px}.editor-layout select{margin-bottom:10px}.graph-viewport{flex:1;position:relative;overflow:hidden;background-image:radial-gradient(#394a57 1px,transparent 1px);touch-action:none}.graph-world{position:absolute;inset:0;transform-origin:0 0}.flow-node{position:absolute;width:320px;border:1px solid #526776;border-radius:10px;background:#1e2b35;padding:12px;cursor:pointer}.flow-node.selected{border-color:#67d5c5;box-shadow:0 0 0 1px #67d5c5}.flow-node header{cursor:grab;display:flex;flex-direction:column;gap:6px}.flow-node header span{font-size:12px;color:#73cfc4}.flow-node small{display:block;margin-top:12px;color:#acbac6}.edges{position:absolute;width:1px;height:1px;overflow:visible;pointer-events:none}.edges line{stroke:#67a8be;stroke-width:2}.edge-row{display:flex;gap:6px;padding:8px 0;border-bottom:1px solid #34404b}.edge-row button{margin-left:auto}
</style>
