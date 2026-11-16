<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { browserUuid } from "../../../../../ribiwebgui/src/browserUuid";
import { managerEventSource } from "../../../../../ribiwebgui/src/managerApi";
const props=defineProps<{projectId:string;canvasId:string;revision:number;dirty:boolean;states?:Record<string,{label:string}>}>();
type Attempt={id:string;nodeId:string;title?:string;state:string;reason?:string;reusedFromAttemptId?:string;artifacts?:{artifactId:string;key:string;bytes:number}[]};
type Run={id:string;projectId:string;canvasId:string;state:string;reason?:string;attempts:Record<string,Attempt>};
const run=ref<Run>(),error=ref(""),busy=ref(false),identity=ref(""),evidence=ref("{}"),entries=ref<{sequence:number;stream:string;text:string}[]>([]);
const concurrency=ref(1),history=ref<{id:string;state:string;createdAt:string;canvasRevision:number}[]>([]),historyCursor=ref<string|null>(null);
const logsLoading=ref(false),logsAtEnd=ref(false);
const pendingKey='workbench-request:'+props.projectId+':'+props.canvasId;
let request:{id:string;revision:number;concurrency?:number;resumeRunId?:string}|undefined,after=0,events:EventSource|undefined,refreshFlight:Promise<void>|undefined;
async function api<T>(url:string,method="GET",body?:unknown):Promise<T>{const response=await fetch(url,{method,headers:{"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});const result=await response.json();if(!response.ok)throw new Error(result.message||"运行请求失败。");return result;}
async function action(fn:()=>Promise<unknown>){if(busy.value)return;busy.value=true;error.value="";try{await fn();}catch(cause){error.value=cause instanceof Error?cause.message:String(cause);}finally{busy.value=false;}}
async function readLatest(){
  if(!run.value&&!request)return;
  const id=run.value?.id||request!.id;
  const result=await api<Run>(`/api/video/v2/runs/${id}`);
  if(result.projectId!==props.projectId||result.canvasId!==props.canvasId)throw new Error("运行不属于当前画布。");
  if((run.value?.id||request?.id)!==id)return;
  run.value=result;
  const page=await api<{entries:typeof entries.value;nextCursor:number}>(`/api/video/v2/runs/${id}/logs?after=${after}&limit=100`);
  if(run.value?.id!==id)return;
  entries.value=[...entries.value,...page.entries].slice(-500);
  after=page.nextCursor;logsAtEnd.value=page.entries.length<100;
}
function refresh(){
  if(refreshFlight)return refreshFlight;
  logsLoading.value=true;
  return refreshFlight=readLatest().finally(()=>{refreshFlight=undefined;logsLoading.value=false;});
}
async function restartLogs(){
  try{await refreshFlight;}
  finally{entries.value=[];after=0;logsAtEnd.value=false;}
  await refresh();
}
async function loadHistory(next=false){
  const query=new URLSearchParams({limit:'20'});if(next&&historyCursor.value)query.set('cursor',historyCursor.value);
  const result=await api<{runs:typeof history.value;nextCursor:string|null}>(`/api/video/v2/projects/${props.projectId}/canvases/${props.canvasId}/runs?${query}`);
  history.value=next?[...new Map([...history.value,...result.runs].map(row=>[row.id,row])).values()]:result.runs;
  historyCursor.value=result.nextCursor;
}
async function openRun(id:string){if(request)throw new Error('请先核对未决运行请求。');await refreshFlight;run.value=await api<Run>(`/api/video/v2/runs/${id}`);entries.value=[];after=0;logsAtEnd.value=false;const url=new URL(location.href);url.searchParams.set('run',id);window.history.replaceState(null,'',url);await refresh();}
async function start(resume=false){
  if(props.dirty)throw new Error("请先保存画布。");
  if(!request)request={id:browserUuid(),revision:props.revision,concurrency:concurrency.value,...(resume&&run.value?{resumeRunId:run.value.id}:{})};
  const original=request;try{sessionStorage.setItem(pendingKey,JSON.stringify(original));}catch{}const url=new URL(location.href);url.searchParams.set('run',original.id);window.history.replaceState(null,'',url);run.value=await api<Run>(`/api/video/v2/projects/${props.projectId}/canvases/${props.canvasId}/runs`,"POST",original);request=undefined;try{sessionStorage.removeItem(pendingKey);}catch{}await restartLogs();
}
async function cancel(){if(!run.value)return;run.value=await api<Run>(`/api/video/v2/runs/${run.value.id}/cancel`,"POST");}
async function reconcile(){if(!run.value)return;await api(`/api/video/v2/runs/${run.value.id}/refresh`,"POST");await refresh();}
async function complete(attempt:Attempt){if(!run.value)return;await api(`/api/video/v2/runs/${run.value.id}/complete`,"POST",{nodeId:attempt.nodeId,attemptId:attempt.id,identity:identity.value,evidence:JSON.parse(evidence.value)});await refresh();}
onMounted(()=>{void action(async()=>{await loadHistory();try{const pending=sessionStorage.getItem(pendingKey);if(pending)request=JSON.parse(pending);}catch{}const id=new URL(location.href).searchParams.get('run');if(id){run.value=await api<Run>(`/api/video/v2/runs/${id}`);await refresh();}});events=managerEventSource("/api/events");events.addEventListener("plugin_event",event=>{try{const payload=JSON.parse((event as MessageEvent).data),value=payload.data?.instanceId?payload.data:payload;if(value.name==="workbench.changed"&&value.data?.runId===run.value?.id)void refresh().catch(cause=>{error.value=String(cause);});}catch{error.value="运行事件读取失败，请刷新原运行。";}});});
onBeforeUnmount(()=>events?.close());
</script>
<template>
  <section class="run-panel">
    <div class="run-toolbar">
      <v-btn :disabled="busy||dirty" color="primary" @click="action(()=>start())">{{request?'恢复原运行请求':'运行画布'}}</v-btn>
      <label>并发 <input v-model.number="concurrency" type="number" min="1" max="16" style="width:60px" /></label>
      <v-btn v-if="run" :disabled="busy||dirty||!!request" @click="action(()=>start(true))">续跑</v-btn>
      <v-btn v-if="run||request" :disabled="busy" @click="action(refresh)">查询原运行</v-btn>
      <v-btn v-if="run" :disabled="busy" @click="action(reconcile)">核对原执行</v-btn>
      <v-btn v-if="run" :disabled="busy" @click="action(cancel)">停止</v-btn>
      <strong v-if="run">{{run.state}}</strong>
    </div>
    <v-alert v-if="error" type="error" variant="tonal">{{error}}</v-alert>
    <p v-if="run?.reason">{{run.reason}}</p>
    <div v-if="run" class="run-results">
      <div v-for="attempt in run.attempts" :key="attempt.id">
        <span>{{attempt.title||attempt.nodeId}}</span><strong>{{states?.[attempt.state]?.label||attempt.state}}</strong>
        <small>{{attempt.reason}}</small><small v-if="attempt.reusedFromAttemptId">复用已核验产物</small>
        <a v-for="artifact in attempt.artifacts" :key="artifact.artifactId" :href="'/api/video/v2/runs/'+run.id+'/artifacts?artifact='+artifact.artifactId" target="_blank" rel="noopener">{{artifact.key}} · {{artifact.bytes}} B</a>
        <v-btn v-if="attempt.state==='waiting_human'" :disabled="!identity||busy" @click="action(()=>complete(attempt))">提交检查</v-btn>
      </div>
    </div>
    <div v-if="run&&Object.values(run.attempts).some(a=>a.state==='waiting_human')" class="human-evidence">
      <v-text-field v-model="identity" label="检查人身份"/><v-textarea v-model="evidence" label="检查证据（JSON）" rows="3"/>
    </div>
    <pre v-if="entries.length" class="run-log">{{entries.map(row=>`${row.sequence} [${row.stream}] ${row.text}`).join('\n')}}</pre>
    <div v-if="run" class="run-toolbar">
      <v-btn :disabled="busy||logsLoading||logsAtEnd" @click="action(refresh)">{{logsAtEnd?'已读取到日志末尾':'继续读取日志'}}</v-btn>
      <v-btn :disabled="busy||logsLoading" @click="action(restartLogs)">从头读取日志</v-btn>
      <small v-if="entries.length">显示第 {{entries[0].sequence}}–{{entries[entries.length-1].sequence}} 条，最多保留最近 500 条</small>
    </div>
    <details><summary @click="action(()=>loadHistory())">运行历史</summary>
      <div v-for="row in history" :key="row.id"><button :disabled="busy||!!request" @click="action(()=>openRun(row.id))">{{row.createdAt}} · {{row.state}} · 画布修订 {{row.canvasRevision}}</button></div>
      <v-btn v-if="historyCursor" :disabled="busy" @click="action(()=>loadHistory(true))">下一页</v-btn>
    </details>
  </section>
</template>
<style scoped>.run-panel{border-top:1px solid #34404b;padding:12px 20px}.run-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.run-results{max-height:240px;overflow:auto}.run-results>div{display:flex;gap:12px;padding:8px;border-bottom:1px solid #34404b;align-items:center}.run-results span{max-width:240px;overflow:hidden;text-overflow:ellipsis}.run-results small{color:#bdc9d2}.run-log{max-height:200px;overflow:auto;background:#0b1115;padding:12px;white-space:pre-wrap}.human-evidence{max-width:700px;margin-top:16px}</style>
