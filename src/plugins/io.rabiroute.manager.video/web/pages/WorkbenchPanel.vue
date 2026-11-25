<script setup lang="ts">
import { previewAccessDenied, readPreview, writePreview } from "../../../../../ribiwebgui/src/readPreviewCache";
import { loadWorkbenchDefinition } from "./workbenchDefinition";
import WorkbenchAgentPicker from "./WorkbenchAgentPicker.vue";
import WorkbenchAgentChat from "./WorkbenchAgentChat.vue";
import { agentSelectionFromConfig, applyAgentSelection } from "./workbenchAgentCatalog";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { browserUuid } from "../../../../../ribiwebgui/src/browserUuid";
import WorkbenchRunPanel from "./WorkbenchRunPanel.vue";
import WorkbenchNodeFields from "./WorkbenchNodeFields.vue";
import WorkbenchCanvasList from "./WorkbenchCanvasList.vue";
import { connectGraph, stageLayout, initialFlowNodeConfig, mergePage, rebaseWorkflowInputs, type CanvasCover, type CanvasPreview, type CanvasSummary, type FlowNode, type TextPreview, type Point, type WorkbenchCanvas, type WorkbenchDefinition } from "./workbenchEditor";
const props = defineProps<{
  projectId: string;
  projectTitle?: string;
  listHidden?: boolean;
  listRevision?: number;
  lastOpenedCanvasId?: string;
  resolveCover?: (preview?: CanvasPreview) => CanvasCover | undefined;
  canvasId?: string;
  nodeId?: string;
  materialInputs?: FlowNode["inputs"];
  edgeId?: string;
  mode?: "node" | "settings" | "list" | "run";
  contentCount?: number;
  prepareRun?: () => Promise<number>;
  commit?: (draft: WorkbenchCanvas, nodeId?: string) => Promise<WorkbenchCanvas>;
  saveResult?: (nodeId: string, result: TextPreview) => Promise<WorkbenchCanvas>;

}>();
const emit = defineEmits<{back:[];media:[canvasId:string,runId?:string];runSelected:[runId:string];cliSettings:[]}>();
const project=ref<{title:string;revision:number;defaultCanvasId:string}>(),definition=ref<WorkbenchDefinition>();
const listPreviewKey = (projectId: string) => ["workbench", "canvases", projectId];
const listPreview = props.mode === "list" ? readPreview<CanvasSummary[]>(listPreviewKey(props.projectId)) : undefined;
const rows=ref<CanvasSummary[]>(listPreview ?? []),cursor=ref<string|null>(null),search=ref(""),trimmed=ref(0),listLoading=ref(false);
const value=ref<WorkbenchCanvas>(),error=ref(""),busy=ref(false),dirty=ref(false),selected=ref(""),selectedEdge=ref("");
const editor=ref(""),variables=ref("[]"),edgeFrom=ref(""),edgeTo=ref(""),edgeCondition=ref("success"),pastedFolder=ref("");
const conflict=ref(false),recovery=ref<string>(),showAdvanced=ref(false),discarding=ref(false),showDraftDiff=ref(false);
const positions = ref<Record<string, Point>>({});
const base=computed(()=>`/api/video/v2/projects/${encodeURIComponent(props.projectId)}`);
const nodeIndex=computed(()=>new Map(value.value?.graph.nodes.map(node=>[node.id,node])||[]));
const activeNode=computed(()=>nodeIndex.value.get(selected.value));
const creativeNode=computed(()=>activeNode.value?.kind==="agent" && typeof activeNode.value.config.textPrompt==="string");
const activeEdge=computed(()=>value.value?.graph.edges.find(edge=>edge.id===selectedEdge.value));
const parsedNode=computed(()=>{try{const parsed=JSON.parse(editor.value);return parsed&&parsed.config&&typeof parsed.config==="object"&&!Array.isArray(parsed.config)?parsed:undefined;}catch{return undefined;}});
watch([() => props.materialInputs, () => !!parsedNode.value && (parsedNode.value.inputs === undefined || Array.isArray(parsedNode.value.inputs))], () => {
  const node = activeNode.value, parsed = parsedNode.value;
  if (props.mode !== "node" || !node || !parsed || parsed.inputs !== undefined && !Array.isArray(parsed.inputs)) return;
  const before = node.inputs ?? [], after = props.materialInputs ?? [];
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  const inputs = rebaseWorkflowInputs(parsed.inputs ?? [], before, after);
  node.inputs = JSON.parse(JSON.stringify(after));
  editor.value = JSON.stringify({ ...parsed, inputs }, null, 2);
});
let disposed=false,actionId=0,openId=0,listId=0,initId=0;
let openController:AbortController|undefined,listController:AbortController|undefined;
let listFlight:{key:string;promise:Promise<void>}|undefined,saveFlight:Promise<void>|undefined;
const draftKey=(projectId:string,id:string)=>`workbench-draft:${projectId}:${id}`;
const listError = ref("");
const listLoaded = ref(!!listPreview);
let lastListReadAt = 0;
let loadedTerm = "";

class RequestError extends Error{constructor(message:string,readonly status:number){super(message);}}
async function api<T>(suffix:string,method="GET",body?:unknown,options:{root?:string;signal?:AbortSignal}={}):Promise<T>{
  const response=await fetch((options.root||base.value)+suffix,{method,headers:{"content-type":"application/json"},signal:options.signal,...(body===undefined?{}:{body:JSON.stringify(body)})});
  const result=await response.json();if(!response.ok)throw new RequestError(result.message||"工作台请求失败。",response.status);return result;
}
async function action(fn:()=>Promise<unknown>){if(busy.value||disposed)return;const token=++actionId;busy.value=true;error.value="";try{await fn();}catch(cause){if(token===actionId&&!disposed&&!(cause instanceof Error&&cause.name==="AbortError"))error.value=cause instanceof Error?cause.message:String(cause);}finally{if(token===actionId&&!disposed)busy.value=false;}}
async function list(append = false) {
  const root = base.value;
  const term = search.value;
  const after = append ? cursor.value : null;
  if (append && !after) return;
  const key = JSON.stringify([root, term, after]);
  if (listFlight?.key === key) return listFlight.promise;
  const token = ++listId;
  listController?.abort();
  const controller = new AbortController();
  listController = controller;
  listLoading.value = true;
  listError.value = "";
  const query = new URLSearchParams({ limit: "50", search: term });
  if (after) query.set("cursor", after);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
  const operation = (async () => {
    try {
      const page = await api<{ canvases: CanvasSummary[]; nextCursor: string | null }>(`/canvases?${query}`, "GET", undefined, { root, signal });
      if (disposed || token !== listId || root !== base.value || term !== search.value) return;
      if (append) {
        const merged = mergePage(rows.value, page.canvases);
        rows.value = merged.rows;
        trimmed.value += merged.removed;
      } else {
        rows.value = page.canvases;
        trimmed.value = 0;
        loadedTerm = term;
        lastListReadAt = Date.now();
        if (!term) writePreview(listPreviewKey(props.projectId), page.canvases);
      }
      cursor.value = page.nextCursor;
      listLoaded.value = true;
    } catch (failure) {
      if (disposed || token !== listId || controller.signal.aborted) return;
      if (failure instanceof RequestError && previewAccessDenied(failure.status)) {
        rows.value = [];
        cursor.value = null;
        listLoaded.value = false;
        writePreview(listPreviewKey(props.projectId), undefined);
      }
      const detail = failure instanceof Error ? failure.message : String(failure);
      listError.value = signal.aborted ? "画布列表加载超时。" : detail;
    } finally {
      if (token === listId) {
        listLoading.value = false;
        listFlight = undefined;
      }
    }
  })();
  listFlight = { key, promise: operation };
  return operation;
}
function rememberDraft(projectId=props.projectId){if(!value.value||!dirty.value)return;try{const key=draftKey(projectId,value.value.id),keys=JSON.parse(sessionStorage.getItem("workbench-draft-keys")||"[]").filter((entry:string)=>entry!==key);keys.push(key);while(keys.length>8)sessionStorage.removeItem(keys.shift());sessionStorage.setItem(key,draftSnapshot(true));sessionStorage.setItem("workbench-draft-keys",JSON.stringify(keys));}catch{}}
function forgetDraft(projectId=props.projectId,id=value.value?.id){if(id)try{sessionStorage.removeItem(draftKey(projectId,id));}catch{}}
type DraftRecord={savedAt?:number;canvas:WorkbenchCanvas;editor?:string;variables?:string;positions?:Record<string,Point>;nodeId?:string};
function readDraftRecord(raw:string|undefined):DraftRecord|undefined{
  if(!raw)return undefined;
  try{const parsed=JSON.parse(raw);if(Array.isArray(parsed)){const [canvas,editor,variables,positions,nodeId]=parsed;return canvas?{canvas,editor,variables,positions,nodeId}:undefined;}return parsed&&parsed.canvas?parsed as DraftRecord:undefined;}catch{return undefined;}
}
const draft=computed(()=>readDraftRecord(recovery.value));
function draftAge(at?:number){if(!at)return"";const seconds=Math.round((Date.now()-at)/1000);if(!Number.isFinite(seconds)||seconds<45)return"刚刚";const minutes=Math.round(seconds/60);if(minutes<60)return`${minutes} 分钟前`;const hours=Math.round(minutes/60);if(hours<24)return`${hours} 小时前`;const days=Math.round(hours/24);return days<7?`${days} 天前`:new Date(at).toLocaleDateString();}
const draftSummary=computed(()=>{
  const record=draft.value,current=value.value,nodeId=record?.nodeId,changedNode=nodeId?nodeIndex.value.get(nodeId):undefined;
  const title=changedNode?`「${changedNode.title||changedNode.kind}」有未保存的输入`:"画布有未保存的修改";
  if(!record||!current)return{title,detail:draftAge(record?.savedAt),changes:[] as string[]};
  const before=new Map(current.graph.nodes.map(node=>[node.id,node])),after=new Map(record.canvas.graph.nodes.map(node=>[node.id,node])),changes:string[]=[];
  for(const [id,node] of after){const previous=before.get(id);if(!previous)changes.push(`新增节点「${node.title||node.kind}」`);else if(JSON.stringify(previous.config)!==JSON.stringify(node.config)||previous.title!==node.title)changes.push(`修改节点「${node.title||node.kind}」`);}
  for(const [id,node] of before)if(!after.has(id))changes.push(`删除节点「${node.title||node.kind}」`);
  if(typeof record.variables==="string"&&record.variables!==JSON.stringify(current.variables,null,2))changes.push("画布变量有改动");
  if(Object.entries(record.positions||{}).some(([id,point])=>{const layout=current.graph.nodes.find(node=>node.id===id)?.layout;return !layout||layout.x!==point.x||layout.y!==point.y;}))changes.push("节点位置有改动");
  if(record.editor&&nodeId){try{const applied=JSON.parse(record.editor),node=after.get(nodeId);if(node&&JSON.stringify(applied.config)!==JSON.stringify(node.config))changes.push(`「${node.title||node.kind}」的参数还没应用`);}catch{}}
  return{title,detail:[draftAge(record.savedAt),changes.length?`${changes.length} 处改动`:""].filter(Boolean).join(" · "),changes};
});
function restoreDraft(){
  if(!recovery.value)return;
  const record=draft.value;if(!record)return;
  const revision=value.value?.revision,canvas=JSON.parse(JSON.stringify(record.canvas)) as WorkbenchCanvas;
  if(revision!==undefined)canvas.revision=revision;
  value.value=canvas;editor.value=record.editor??"";if(typeof record.variables==="string")variables.value=record.variables;
  positions.value=record.positions||{};selected.value=record.nodeId||"";
  dirty.value=true;discarding.value=false;showDraftDiff.value=false;recovery.value=undefined;
}
function discardDraft(){if(!discarding.value){discarding.value=true;return;}forgetDraft();recovery.value=undefined;discarding.value=false;showDraftDiff.value=false;}
function settleNodeDraft(){
  if(props.mode!=="node"||!recovery.value)return;
  const record=draft.value;recovery.value=undefined;discarding.value=false;showDraftDiff.value=false;
  if(record?.editor&&record.nodeId===props.nodeId){editor.value=record.editor;dirty.value=true;}
}
async function open(id:string){
  if(dirty.value)throw new Error("当前画布尚未保存。请保存或导出草稿后再切换。");
  const root=base.value,token=++openId;openController?.abort();const controller=new AbortController();openController=controller;
  const record=await api<WorkbenchCanvas>(`/canvases/${encodeURIComponent(id)}`,"GET",undefined,{root,signal:AbortSignal.any([controller.signal, AbortSignal.timeout(10000)])});
  if(disposed||token!==openId||root!==base.value)return;
  if(dirty.value)throw new Error("打开期间产生了新编辑，已保留当前画布。");
  value.value=record;selected.value="";selectedEdge.value="";editor.value="";variables.value=JSON.stringify(record.variables,null,2);conflict.value=false;
  positions.value=Object.fromEntries(record.graph.nodes.map(node=>[node.id,node.layout||{x:0,y:0}]));
  try{recovery.value=sessionStorage.getItem(draftKey(props.projectId,id))||undefined;}catch{recovery.value=undefined;}

}
async function chooseCanvas(id: string, runId?: string) {
  if (dirty.value) await save();
  if (!dirty.value) {
    if (!rows.value.some(row => row.id === id)) lastListReadAt = 0;
    emit("media", id, runId);
  }
}
async function create(){const root=base.value,record=await api<WorkbenchCanvas>("/canvases","POST",{id:browserUuid()},{root});if(root===base.value&&!disposed)await chooseCanvas(record.id);}
async function importFile(event:Event){const input=event.target as HTMLInputElement,file=input.files?.[0];input.value="";if(!file)return;if(file.size>64*1024*1024-4096)throw new Error("导入定义或材料包最大 64 MB。");const root=base.value,parsed=JSON.parse(await file.text()),packet=parsed&&typeof parsed==="object"&&Object.hasOwn(parsed,"source")&&!parsed.graph&&!parsed.nodes,body={id:browserUuid(),source:packet?parsed.source:parsed,...(packet&&parsed.materials!==undefined?{materials:parsed.materials}:{})};if(root!==base.value)return;const record=await api<WorkbenchCanvas>("/canvases/import","POST",body,{root});if(root===base.value&&!disposed)await chooseCanvas(record.id);}
function parseDraft(text:string,label:string){try{return JSON.parse(text);}catch{throw new Error(`${label} JSON 无效，请修正后重试。当前草稿已保留。`);}}
function applyNode(){const node=activeNode.value;if(!node)return;const parsed=parseDraft(editor.value,"节点参数");if(!parsed||!parsed.config||typeof parsed.config!=="object"||Array.isArray(parsed.config))throw new Error("节点参数需要 config 对象。当前草稿已保留。");if(parsed.inputs!==undefined&&!Array.isArray(parsed.inputs)||parsed.requirements!==undefined&&!Array.isArray(parsed.requirements))throw new Error("输入与产物要求需要数组。当前草稿已保留。");if(JSON.stringify(parsed)===JSON.stringify({config:node.config,inputs:node.inputs||[],requirements:node.requirements||[]}))return;node.config=parsed.config;node.inputs=parsed.inputs;node.requirements=parsed.requirements;dirty.value=true;}
function select(node:FlowNode){if(selected.value===node.id)return;applyNode();selected.value=node.id;selectedEdge.value="";editor.value=JSON.stringify({config:node.config,inputs:node.inputs||[],requirements:node.requirements||[]},null,2);}
function updateConfig(config:Record<string,unknown>){if(!parsedNode.value)return;editor.value=JSON.stringify({...parsedNode.value,config},null,2);dirty.value=true;}
function updateRows(kind:"inputs"|"requirements",index:number,key:string,next:unknown){if(!parsedNode.value)return;const parsed=JSON.parse(editor.value),rows=parsed[kind]||[];rows[index]={...rows[index],[key]:next};editor.value=JSON.stringify({...parsed,[kind]:rows},null,2);dirty.value=true;}
function updateRef(index:number,key:string,next:string){const current=parsedNode.value?.inputs?.[index]?.ref||{};updateRows("inputs",index,"ref",{...current,[key]:next});}
function addRow(kind:"inputs"|"requirements"){if(!parsedNode.value)return;const parsed=JSON.parse(editor.value),rows=parsed[kind]||[];rows.push(kind==="inputs"?{ref:{root:"canvas",path:""}}:{key:`output-${rows.length+1}`,root:"output",path:"",type:"file",required:true,freshness:"produced"});editor.value=JSON.stringify({...parsed,[kind]:rows},null,2);dirty.value=true;}
function removeRow(kind:"inputs"|"requirements",index:number){if(!parsedNode.value)return;const parsed=JSON.parse(editor.value);parsed[kind].splice(index,1);editor.value=JSON.stringify(parsed,null,2);dirty.value=true;}
function add(kind:string){if(!value.value)return;applyNode();const id=browserUuid();positions.value[id] = { x: Math.max(-420, ...Object.values(positions.value).map(point => point.x)) + 420, y: 0 };const config=initialFlowNodeConfig(kind);const node={id,kind,title:definition.value?.capabilities[kind]?.label||kind,enabled:true,config,layout:positions.value[id]};value.value.graph.nodes.push(node);select(node);dirty.value=true;}
function connect(from=edgeFrom.value,to=edgeTo.value,fromPort="control",toPort="control"){if(!value.value||!definition.value)return;applyNode();const edge=connectGraph(value.value.graph,definition.value,{id:browserUuid(),from,to,fromPort,toPort,condition:edgeCondition.value});value.value.graph.edges.push(edge);selectedEdge.value=edge.id;dirty.value=true;}
function remove(){if(!value.value)return;const id=selected.value,graph=value.value.graph;graph.nodes=graph.nodes.filter(node=>node.id!==id);graph.edges=graph.edges.filter(edge=>edge.from!==id&&edge.to!==id);for(const group of graph.groups)group.nodeIds=group.nodeIds.filter(nodeId=>nodeId!==id);delete positions.value[id];selected.value="";editor.value="";dirty.value=true;}
function removeEdge(id:string){if(!value.value)return;value.value.graph.edges=value.value.graph.edges.filter(edge=>edge.id!==id);selectedEdge.value="";dirty.value=true;}
function autoLayout() {
  if (!value.value || !definition.value) return;
  applyNode();
  const layout = stageLayout(value.value.graph, definition.value);
  for (const node of value.value.graph.nodes) if (!node.config.legacyCardId && layout[node.id]) positions.value[node.id] = { ...node.layout, ...layout[node.id]! };
  dirty.value = true;
}
function draftPayload(){applyNode();const payload=JSON.parse(JSON.stringify(value.value)) as WorkbenchCanvas;payload.variables=parseDraft(variables.value,"变量");for(const node of payload.graph.nodes)node.layout=positions.value[node.id]||node.layout;return payload;}
function draftSnapshot(stamped=false){return JSON.stringify({...(stamped?{savedAt:Date.now()}:{}),canvas:value.value,editor:editor.value,variables:variables.value,positions:positions.value,nodeId:selected.value});}
async function save(){if(saveFlight)return saveFlight;if(!value.value)return;const current=value.value,root=base.value,projectId=props.projectId,payload=draftPayload(),submitted=draftSnapshot();
  const operation=(async()=>{try{const saved=props.commit ? await props.commit(payload, props.mode==="node" ? props.nodeId : undefined) : await api<WorkbenchCanvas>(`/canvases/${payload.id}`,"PUT",payload,{root});if(disposed||root!==base.value||value.value!==current)return;if(draftSnapshot()===submitted){value.value=saved;dirty.value=false;forgetDraft(projectId,payload.id);}else{value.value.revision=saved.revision;dirty.value=true;}conflict.value=false;}catch(cause){if(root===base.value&&value.value===current&&cause instanceof RequestError&&cause.status===409){conflict.value=true;rememberDraft();}throw cause;}})();saveFlight=operation;try{await operation;}finally{if(saveFlight===operation)saveFlight=undefined;}}
async function saveBeforeRun(){
  if (!value.value || !activeNode.value) throw new Error("节点尚未打开。");
  if (dirty.value) await save();
  if (dirty.value || !value.value) throw new Error("请先保存当前节点的修改。");
  return props.prepareRun ? await props.prepareRun() : value.value.revision;
}
async function storeResult(result:TextPreview){
  if(!props.nodeId||!props.saveResult)return;
  const saved=await props.saveResult(props.nodeId,result);
  if(!disposed&&value.value?.id===saved.id)value.value.revision=saved.revision;
}
async function reloadServer(){if(!value.value)return;const id=value.value.id,wasDirty=dirty.value;dirty.value=false;try{await open(id);forgetDraft();recovery.value=undefined;}catch(cause){dirty.value=wasDirty;throw cause;}}
async function backToProjects() {
  // Keep the editor and its unsaved changes visible if the save fails.
  if (dirty.value) await save();
  if (!dirty.value) emit("back");
}
async function copy(row:{id:string;name:string}){const root=base.value,copied=await api<WorkbenchCanvas>("/canvases/copy","POST",{id:browserUuid(),requestId:browserUuid(),sourceCanvasId:row.id,name:`${row.name} 副本`},{root});if(root===base.value&&!disposed)await chooseCanvas(copied.id);}
async function registerFolder(){const root=base.value,record=await api<WorkbenchCanvas>("/canvases/copy","POST",{id:browserUuid(),requestId:browserUuid(),folderName:pastedFolder.value},{root});if(root===base.value&&!disposed)await chooseCanvas(record.id);}
async function setDefault(){if(!value.value||!project.value)return;const root=base.value,record=await api<typeof project.value>("","PUT",{revision:project.value.revision,defaultCanvasId:value.value.id},{root});if(root===base.value&&!disposed)project.value=record;}
async function exportDraft(){if(!value.value)return;const blob=new Blob([JSON.stringify(draftPayload(),null,2)],{type:"application/json"}),url=URL.createObjectURL(blob),link=document.createElement("a");link.href=url;link.download=`${value.value.id}.json`;link.click();URL.revokeObjectURL(url);}
function ports(node:FlowNode,direction:"in"|"out"){return definition.value?.capabilities[node.kind]?.ports?.[direction]||[];}
function protect(event:BeforeUnloadEvent){if(dirty.value){rememberDraft();event.preventDefault();event.returnValue="";}}
async function initialize(){
  if (props.mode === "list") { await list(); return; }
  const token = ++initId, root = base.value;
  const params = new URL(location.href).searchParams;
  const canvasId = props.canvasId || params.get("canvas");
  const opening = canvasId ? open(canvasId) : undefined;
  const identity = api<typeof project.value>("", "GET", undefined, { root, signal: AbortSignal.timeout(10000) });
  const definitions = loadWorkbenchDefinition(fetch);
  const [record, entry] = await Promise.all([identity, definitions, opening]);
  if (disposed || token !== initId || root !== base.value) return;
  definition.value = entry;
  project.value = record;
  if (!canvasId && record) await open(record.defaultCanvasId);
  if (disposed || token !== initId || root !== base.value) return;
  const node = props.nodeId && nodeIndex.value.get(props.nodeId);
  if (node && !node.config.legacyCardId) select(node);
  selectedEdge.value = props.edgeId || "";
  settleNodeDraft();
}
watch(()=>props.projectId,(_next,previous)=>{rememberDraft(previous);++actionId;++openId;++listId;++initId;openController?.abort();listController?.abort();busy.value=false;saveFlight=undefined;listFlight=undefined;value.value=undefined;project.value=undefined;dirty.value=false;selected.value="";editor.value="";rows.value=[];cursor.value=null;listLoading.value=false;listLoaded.value=false;listError.value="";recovery.value=undefined;void action(initialize);});
watch(() => props.listRevision, () => { lastListReadAt = 0; });
watch(() => props.listHidden, hidden => {
  if (props.mode === "list" && !hidden && loadedTerm === search.value &&
      rows.value.length <= 50 && !trimmed.value && Date.now() - lastListReadAt > 15_000) void list();
});
onMounted(()=>{void (props.mode === "list" ? initialize() : action(initialize));window.addEventListener("beforeunload",protect);});
onBeforeUnmount(()=>{rememberDraft();disposed=true;++openId;++listId;++initId;++actionId;openController?.abort();listController?.abort();window.removeEventListener("beforeunload",protect);});
</script>
<template>
  <section class="workbench" :class="{'workbench-inline':mode==='node','workbench-catalog':mode==='list'}">
    <header v-if="mode !== 'node'" class="workbench-header">
      <v-btn v-if="mode === 'list'" :disabled="busy" prepend-icon="mdi-arrow-left" variant="text" @click="action(backToProjects)">我的项目</v-btn>
      <strong>{{mode === 'run' ? '运行与记录' : mode === 'list' ? projectTitle || '画布列表' : '画布设置'}}</strong>
      <v-spacer/>
      <template v-if="value && mode === 'settings'">
        <v-btn :disabled="busy" variant="text" @click="action(exportDraft)">导出定义</v-btn>
        <v-btn :disabled="busy || project?.defaultCanvasId === value.id" variant="text" @click="action(setDefault)">设为默认</v-btn>
        <v-btn :disabled="busy || !dirty" color="primary" @click="action(save)">保存</v-btn>
      </template>
      <v-btn v-if="mode === 'list'" variant="text" prepend-icon="mdi-robot-outline" @click="emit('cliSettings')">Agent 设置</v-btn>
      <v-btn v-if="mode === 'list'" :disabled="busy" @click="action(create)">新建画布</v-btn>
      <v-btn v-if="mode !== 'list'" :disabled="busy" variant="text" @click="action(backToProjects)">关闭</v-btn>
    </header>
    <v-alert v-if="error&&!conflict" type="error" variant="tonal">{{error}}</v-alert>
    <v-alert v-if="conflict" type="warning" variant="tonal">服务器版本已更新，本地编辑已保留。<div class="notice-actions"><v-btn @click="action(exportDraft)">导出本地草稿</v-btn><v-btn variant="text" @click="action(reloadServer)">放弃本地编辑，重载服务器版本</v-btn></div></v-alert>
    <div v-if="recovery && mode !== 'node'" class="draft-notice" role="status">
      <div class="draft-notice-head">
        <v-icon icon="mdi-history" size="16" aria-hidden="true"/>
        <strong>{{draftSummary.title}}</strong>
        <small v-if="draftSummary.detail">{{draftSummary.detail}}</small>
        <span class="draft-notice-actions">
          <v-btn size="small" variant="tonal" :disabled="busy" @click="restoreDraft">恢复</v-btn>
          <v-btn v-if="draftSummary.changes.length" size="small" variant="text" @click="showDraftDiff=!showDraftDiff">{{showDraftDiff?'收起改动':'查看改动'}}</v-btn>
          <template v-if="discarding">
            <v-btn size="small" variant="text" color="error" @click="discardDraft">确认丢弃</v-btn>
            <v-btn size="small" variant="text" @click="discarding=false">取消</v-btn>
          </template>
          <v-btn v-else size="small" variant="text" @click="discardDraft">丢弃</v-btn>
        </span>
      </div>
      <ul v-if="showDraftDiff && draftSummary.changes.length" class="draft-changes">
        <li v-for="line in draftSummary.changes" :key="line">{{line}}</li>
      </ul>
    </div>
    <details v-if="mode === 'settings' && value?.importReport" class="report"><summary>导入报告</summary><pre>{{JSON.stringify(value.importReport,null,2)}}</pre></details>
    <details v-if="mode === 'settings' && value?.externalDependencies" class="report"><summary>外部依赖</summary><pre>{{JSON.stringify(value.externalDependencies,null,2)}}</pre></details>
    <template v-if="mode === 'list'">
      <div class="list-tools">
        <h2>画布</h2><v-spacer/>
        <input v-model="search" type="search" aria-label="搜索画布" placeholder="搜索画布" @keyup.enter="list()"/>
        <v-btn :disabled="listLoading" @click="list()">搜索</v-btn>
        <v-btn v-if="listLoaded" variant="text" prepend-icon="mdi-refresh" :disabled="listLoading" @click="list()">刷新</v-btn>
      </div>
      <p v-if="listLoading && !rows.length" class="list-message" role="status">正在加载画布…</p>
      <v-alert v-if="listError" type="error" variant="tonal" class="list-message">
        {{ listError }} <v-btn variant="text" @click="list()">重试</v-btn>
      </v-alert>
      <p v-if="listLoaded && !listLoading && !listError && !rows.length" class="list-message">
        {{ search.trim() ? '没有匹配的画布。' : '还没有画布。' }}
      </p>
      <WorkbenchCanvasList v-if="rows.length" :rows="rows" :disabled="busy" :project-id="projectId"
        :resolve-cover="resolveCover" :hidden="listHidden" :focused-id="lastOpenedCanvasId"
        @open="id => action(() => chooseCanvas(id))" @copy="row => action(() => copy(row))"/>
      <div class="list-footer">
        <small v-if="rows.length">{{ trimmed ? `当前保留第 ${trimmed + 1}–${trimmed + rows.length} 项` : `已加载 ${rows.length} 张画布` }}</small>
        <v-btn v-if="trimmed" variant="text" :disabled="listLoading" @click="list()">返回首页</v-btn>
        <v-btn v-if="cursor" :disabled="listLoading || busy" @click="list(true)">{{ listLoading ? '加载中…' : '加载下一页' }}</v-btn>
      </div>
      <details class="import-tools"><summary>导入与文件夹副本</summary><label>导入定义或材料包<input type="file" accept="application/json,.json" :disabled="busy" @change="event=>action(()=>importFile(event))"/></label><div class="list-tools"><input v-model="pastedFolder" aria-label="已粘贴的文件夹名" placeholder="已粘贴到 canvases/ 的文件夹名"/><v-btn :disabled="!pastedFolder||busy" @click="action(registerFolder)">登记副本</v-btn></div></details>
    </template>
    <template v-else-if="value">
      <div class="editor-layout">
        <aside v-if="mode === 'settings'" class="tool-rail"><label>画布名称<input v-model="value.name" @input="dirty=true"/></label><v-btn variant="text" size="small" @click="action(async()=>autoLayout())">排列流程节点</v-btn><label>执行目录绑定<input v-model="value.workspaceBindingKey" @input="dirty=true"/></label><details><summary>变量</summary><textarea v-model="variables" rows="6" aria-label="画布变量 JSON" @input="dirty=true"/></details><h3>添加节点</h3><div class="node-palette"><button v-for="(entry,kind) in definition?.capabilities" :key="kind" @click="action(async()=>add(String(kind)))"><span aria-hidden="true">＋</span>{{entry.label}}</button></div><details class="connection-tools"><summary>键盘连接</summary><select v-model="edgeFrom" aria-label="前置节点"><option value="">选择前置</option><option v-for="node in value.graph.nodes.filter(n=>ports(n,'out').length)" :key="node.id" :value="node.id">{{node.title}}</option></select><select v-model="edgeTo" aria-label="后继节点"><option value="">选择后继</option><option v-for="node in value.graph.nodes.filter(n=>ports(n,'in').length)" :key="node.id" :value="node.id">{{node.title}}</option></select><select v-model="edgeCondition" aria-label="连接条件"><option value="success">成功后</option><option value="completed">结束后</option></select><v-btn :disabled="!edgeFrom||!edgeTo" @click="action(async()=>connect())">连接</v-btn></details></aside>
        <aside v-if="mode === 'node' && activeNode" class="inspector" :class="{'creative-inspector':creativeNode}" aria-label="节点参数">
          <slot name="references"/>
          <WorkbenchAgentPicker v-if="parsedNode && activeNode.kind === 'agent'" :config="parsedNode.config"
            :model-value="agentSelectionFromConfig(parsedNode.config)"
            @update:model-value="selection=>updateConfig(applyAgentSelection(parsedNode!.config, selection))" @settings="emit('cliSettings')"/>
          <WorkbenchAgentChat v-if="parsedNode && activeNode.kind === 'agent'" :selection="agentSelectionFromConfig(parsedNode.config)"
            :conversation="parsedNode.config.conversation" :multi-turn="parsedNode.config.multiTurn===true"
            @append="text=>updateConfig({...parsedNode!.config,multiTurn:true,conversation:[...(Array.isArray(parsedNode!.config.conversation)?parsedNode!.config.conversation:[]),{role:'user',text}]})"/>
          <template v-if="creativeNode && parsedNode">
            <textarea class="creative-prompt" :value="parsedNode.config.textPrompt" aria-label="生成提示词" maxlength="10000" rows="4"
              placeholder="写下你的要求…" @input="updateConfig({...parsedNode.config,textPrompt:($event.target as HTMLTextAreaElement).value})"/>
            <div class="creative-footer">
              <WorkbenchRunPanel :key="projectId+':'+value.id+':'+activeNode.id" :project-id="projectId" :canvas-id="value.id" :node-id="activeNode.id"
                :revision="value.revision" :dirty="dirty||busy" :can-run="activeNode.enabled!==false && (!!String(parsedNode.config.textPrompt ?? '').trim() || !!contentCount)"
                :save-before-run="saveBeforeRun" :save-result="storeResult" :states="definition?.nodeStates" :run-states="definition?.runStates"/>
            </div>
          </template>
          <component :is="creativeNode ? 'details' : 'div'" class="node-details">
            <summary v-if="creativeNode">节点设置</summary>
            <label>节点名称<input v-model="activeNode.title" @input="dirty=true"/></label><div class="node-flags"><label><input :checked="activeNode.enabled!==false" type="checkbox" @change="activeNode.enabled=($event.target as HTMLInputElement).checked;dirty=true"/>启用</label></div><WorkbenchNodeFields v-if="parsedNode" :kind="activeNode.kind" :fields="definition?.capabilities[activeNode.kind]?.fields" :model-value="parsedNode.config" @update:model-value="updateConfig"/><p v-else class="muted">高级 JSON 无效，修正后可使用表单。</p><details v-if="parsedNode" class="artifact-form"><summary>输入材料（{{parsedNode.inputs?.length||0}}）</summary><div v-for="(input,index) in parsedNode.inputs||[]" :key="index" class="requirement-row"><template v-if="input.producerNodeId"><label>前置节点<select :value="input.producerNodeId" @change="updateRows('inputs',index,'producerNodeId',($event.target as HTMLSelectElement).value)"><option v-for="node in value.graph.nodes.filter(node=>node.id!==selected)" :key="node.id" :value="node.id">{{node.title}}</option></select></label><label>产物名称<input :value="input.artifactKey" @input="updateRows('inputs',index,'artifactKey',($event.target as HTMLInputElement).value)"/></label></template><template v-else><label>位置<select :value="input.ref?.root" @change="updateRef(index,'root',($event.target as HTMLSelectElement).value)"><option v-for="root in ['canvas','materials','output','runtime']" :key="root">{{root}}</option></select></label><label>相对路径<input :value="input.ref?.path" @input="updateRef(index,'path',($event.target as HTMLInputElement).value)"/></label></template><button class="text-danger" @click="removeRow('inputs',index)">移除输入</button></div><button class="add-row" @click="addRow('inputs')">＋ 添加材料输入</button></details><details v-if="parsedNode" class="artifact-form"><summary>产物检查（{{parsedNode.requirements?.length||0}}）</summary><div v-for="(item,index) in parsedNode.requirements||[]" :key="index" class="requirement-row"><label>产物名称<input :value="item.key" @input="updateRows('requirements',index,'key',($event.target as HTMLInputElement).value)"/></label><label>位置<select :value="item.root" @change="updateRows('requirements',index,'root',($event.target as HTMLSelectElement).value)"><option v-for="root in ['output','canvas','materials','runtime']" :key="root">{{root}}</option></select></label><label>相对路径<input :value="item.path" @input="updateRows('requirements',index,'path',($event.target as HTMLInputElement).value)"/></label><label>检查方式<select :value="item.freshness" @change="updateRows('requirements',index,'freshness',($event.target as HTMLSelectElement).value)"><option value="produced">本次生成</option><option value="validated">本次核验</option><option value="reused">复用原产物</option></select></label><button class="text-danger" @click="removeRow('requirements',index)">移除检查</button></div><button class="add-row" @click="addRow('requirements')">＋ 添加产物检查</button></details><details :open="showAdvanced" class="advanced-editor"><summary @click="showAdvanced=!showAdvanced">自由参数（JSON）</summary><label>自由参数、输入与产物要求<textarea v-model="editor" rows="16" spellcheck="false" @input="dirty=true"/></label></details><v-btn size="small" variant="tonal" @click="action(save)">保存参数</v-btn><v-btn size="small" color="error" variant="text" @click="action(async()=>{remove(); await save();})">移除节点</v-btn>
          </component>
        </aside>
      </div><div v-if="mode === 'settings' && activeEdge" class="edge-inspector"><strong>{{nodeIndex.get(activeEdge.from)?.title}} → {{nodeIndex.get(activeEdge.to)?.title}}</strong><label>触发条件<select v-model="activeEdge.condition" @change="if(activeEdge.condition!=='completed')delete activeEdge.allowSkip;dirty=true"><option value="success">前置成功后</option><option value="completed">前置结束后</option></select></label><label v-if="activeEdge.condition==='completed'&&nodeIndex.get(activeEdge.from)?.optional"><input v-model="activeEdge.allowSkip" type="checkbox" @change="dirty=true"/>允许前置跳过</label><button class="text-danger" @click="removeEdge(activeEdge.id)">移除连接</button></div>
      <section v-if="mode === 'run'" aria-label="画布运行">
        <WorkbenchRunPanel :key="projectId+':'+value.id" :project-id="projectId" :canvas-id="value.id" :revision="value.revision" :dirty="dirty||busy" :states="definition?.nodeStates" :run-states="definition?.runStates" @edition="(canvasId,runId)=>action(()=>chooseCanvas(canvasId,runId))" @run-selected="runId => emit('runSelected', runId)"/>
      </section>
    </template>
  </section>
</template>
<style scoped>
.workbench{--wb-bg:#101a22;--wb-input:#192630;--wb-text:#eaf1f6;--wb-muted:#9baebc;--wb-border:#30434f;--wb-accent:#89dbc7;background:var(--wb-bg);color:var(--wb-text);font-family:inherit;font-size:14px}.workbench-catalog{--wb-bg:transparent;--wb-input:var(--rr-surface);--wb-text:var(--rr-text);--wb-muted:var(--rr-muted);--wb-border:var(--rr-border);--wb-accent:var(--rr-accent)}.workbench-inline{background:var(--rr-surface);border:1px solid var(--rr-border);border-radius:12px}.workbench-inline .editor-layout .inspector{width:100%;border:0;overflow:visible}.workbench:not(.workbench-inline) .editor-layout .tool-rail{width:100%;border:0}.workbench-header{display:flex;align-items:center;flex-wrap:wrap;gap:12px;padding:12px 18px;border-bottom:1px solid var(--wb-border)}.workbench input,.workbench select,.workbench textarea{color:inherit;background:var(--wb-input);border:1px solid var(--wb-border);border-radius:6px;padding:8px 10px;width:100%;font:inherit}.workbench input:focus,.workbench textarea:focus,.workbench select:focus{outline:1px solid var(--wb-accent);outline-offset:1px}.workbench input[type=checkbox]{width:auto;margin-right:6px;accent-color:var(--wb-accent)}.run-area{scroll-margin-top:16px}.workbench-header>input{max-width:220px;font-weight:550}.save-state{color:#e4c68f;font-size:12px}.report{padding:10px 24px;border-bottom:1px solid var(--wb-border);color:var(--wb-muted)}.report pre{max-height:200px;overflow:auto;white-space:pre-wrap;font-size:12px;margin-top:10px}.list-tools{display:flex;align-items:center;gap:12px;padding:22px 24px}.list-tools h2{font-size:23px;font-weight:500;letter-spacing:1px}.list-tools p{font-size:12px;color:var(--wb-muted);margin-top:4px}.list-tools input[type=search]{max-width:320px}.list-message{margin:0 24px;padding:16px 0}.list-footer{display:flex;align-items:center;justify-content:flex-end;gap:12px;padding:14px 24px}.list-footer small{margin-right:auto;color:var(--wb-muted)}.import-tools{margin:20px 24px;color:var(--wb-muted)}.import-tools>label{display:block;margin:18px 0}.import-tools .list-tools{padding:0}.editor-layout{display:flex;height:auto;min-height:0}.editor-layout aside{width:220px;flex-shrink:0;overflow:auto;padding:16px;border-right:1px solid var(--wb-border)}.editor-layout aside.inspector{width:300px;border-right:0;border-left:1px solid var(--wb-border)}.editor-layout label{display:block;font-size:12px;color:var(--wb-muted);margin:14px 0}.editor-layout label input,.editor-layout label select{margin-top:6px;color:var(--wb-text)}.editor-layout h3{margin:0 0 16px;font-size:11px;font-weight:650;letter-spacing:1.5px;color:var(--wb-muted)}.editor-layout h3:not(:first-child){margin-top:26px}.editor-layout summary{font-size:12px;color:var(--wb-muted);cursor:pointer}.editor-layout details{margin:18px 0}.editor-layout textarea{font-family:ui-monospace,monospace;font-size:12px;resize:vertical;margin-top:8px}.node-palette{display:grid;grid-template-columns:1fr 1fr;gap:7px}.node-palette button{padding:10px 6px;border:1px solid var(--wb-border);border-radius:7px;text-align:left;font-size:12px}.node-palette span{color:var(--wb-accent);margin-right:6px}.node-palette button:hover{background:var(--wb-input);border-color:#68978e}.connection-tools select{margin-top:8px}.node-flags{display:flex;gap:12px;border-bottom:1px solid var(--wb-border);margin-bottom:12px}.node-flags label{white-space:nowrap}.requirement-row{border-left:2px solid #466d65;padding:0 0 8px 12px;margin:12px 0}.add-row{font-size:12px;color:var(--wb-accent);padding:8px 0}.text-danger{font-size:12px;color:#edaaa1;padding:8px}.edge-inspector{display:flex;align-items:center;flex-wrap:wrap;gap:20px;padding:12px 24px;border-top:1px solid var(--wb-border);background:#1a2b34;font-size:12px}.edge-inspector select{width:auto;margin-left:10px}.notice-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:8px}.muted{color:var(--wb-muted);font-size:12px;margin:12px 0}button:focus-visible{outline:2px solid var(--wb-accent);outline-offset:3px}button:disabled{opacity:.5;cursor:default}@media(max-width:950px){.editor-layout aside.tool-rail{width:180px}.editor-layout aside.inspector{width:250px}}@media(prefers-reduced-motion:no-preference){}
</style>

<style scoped>
.creative-inspector { gap:8px; }
.creative-inspector .creative-prompt { min-height:108px; font-size:14px; line-height:1.6; background:var(--rr-surface-raised,var(--rr-surface)); color:var(--rr-text); border-color:var(--rr-border); }
.creative-footer { display:flex; justify-content:space-between; align-items:flex-start; gap:8px; }
.creative-footer > span { color:var(--rr-muted); font-size:12px; padding:7px 0; overflow-wrap:anywhere; }
.node-details { display:grid; gap:10px; }
.node-details:not([open]) > summary { margin:0; }
.node-details[open] > :not(summary) { margin-top:8px; }
.node-details > summary { color:var(--rr-muted); font-size:12px; cursor:pointer; }
.draft-notice { display:grid; gap:8px; margin:10px 14px; padding:10px 12px; border:1px solid var(--rr-border, var(--wb-border)); border-left:3px solid var(--rr-accent, var(--wb-accent)); border-radius:8px; background:var(--rr-surface-raised, var(--rr-surface)); color:var(--rr-text, var(--wb-text)); }
.draft-notice-head { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }
.draft-notice-head strong { font-size:13px; font-weight:600; }
.draft-notice-head small { color:var(--rr-muted, var(--wb-muted)); font-size:12px; }
.draft-notice-actions { display:flex; align-items:center; gap:4px; margin-left:auto; }
.draft-changes { margin:0; padding-left:18px; color:var(--rr-muted, var(--wb-muted)); font-size:12px; display:grid; gap:2px; }
</style>
