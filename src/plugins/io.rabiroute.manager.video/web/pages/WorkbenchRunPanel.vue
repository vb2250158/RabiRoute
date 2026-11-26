<script setup lang="ts">
import {computed,onBeforeUnmount,onMounted,ref,watch} from "vue";
import {browserUuid} from "../../../../../ribiwebgui/src/browserUuid";
import {managerEventSource} from "../../../../../ribiwebgui/src/managerApi";
import {mergePage, type TextPreview} from "./workbenchEditor";
const props=defineProps<{projectId:string;canvasId:string;revision:number;dirty:boolean;nodeId?:string;canRun?:boolean;saveBeforeRun?:()=>Promise<number>;saveResult?:(result:TextPreview)=>Promise<void>;states?:Record<string,{label:string}>;runStates?:Record<string,{label:string}>}>();
const emit=defineEmits<{edition:[canvasId:string,runId:string];runSelected:[runId:string]}>();
type Attempt={id:string;nodeId:string;title?:string;state:string;reason?:string;outputText?:string;reusedFromAttemptId?:string;approval?:{required:boolean;requestedAt?:string};confirmation?:{mode?:string;identity:string;confirmedAt:string;basis?:unknown[]};artifacts?:{artifactId:string;key:string;bytes:number}[]};
type Run={id:string;projectId:string;canvasId:string;state:string;reason?:string;attempts:Record<string,Attempt>;snapshot?:{graph:{nodes:{id:string;config:{instructions?:string}}[]}}};
type Request={id:string;revision:number;concurrency?:number;resumeRunId?:string;nodeId?:string};
type EditionRequest={id:string;date:string;label?:string;concurrency?:number};
type EditionResult={trigger:{id:string;projectId:string;templateId:string;canvasId:string;date:string;runId:string;phase:string};run:Run};
const run=ref<Run>(),request=ref<Request>(),error=ref(""),busy=ref(false),identity=ref(""),evidence=ref("{}");
watch(() => run.value?.id, id => { if (id && !props.nodeId) emit("runSelected", id); });
const entries=ref<{sequence:number;stream:string;text:string}[]>([]),concurrency=ref(1);
const history=ref<{id:string;state:string;createdAt:string;canvasRevision:number}[]>([]),historyCursor=ref<string|null>(null);
const logsLoading=ref(false),logsAtEnd=ref(false),runLabel=computed(()=>run.value?(props.runStates?.[run.value.state]?.label||run.value.state):"");
const nodeAttempt = computed(() => props.nodeId ? run.value?.attempts[props.nodeId] : undefined);
const terminal = new Set(["succeeded","failed","cancelled","completed_with_errors"]);
const waitingStates = new Set(["waiting_human","waiting_approval"]);
const waitingApproval = (attempt:Attempt) => attempt.approval?.required === true && waitingStates.has(attempt.state) && !attempt.confirmation;
const waitingHuman = (attempt:Attempt) => attempt.approval?.required !== true && waitingStates.has(attempt.state);
const pendingHumans = computed(() => Object.values(run.value?.attempts ?? {}).filter(attempt => waitingHuman(attempt) || waitingApproval(attempt)));
const evidenceReady = computed(() => { try { const value = JSON.parse(evidence.value); return !!value && typeof value === "object" && !Array.isArray(value); } catch { return false; } });
function attemptLabel(attempt:Attempt) {
  if (attempt.approval?.required === true && waitingStates.has(attempt.state)) return attempt.confirmation ? "等待执行（已确认）" : "等待确认";
  return props.states?.[attempt.state]?.label || attempt.state;
}
function confirmationNote(attempt:Attempt) {
  const confirmation = attempt.confirmation;
  if (!confirmation) return "";
  const basis = Array.isArray(confirmation.basis) ? confirmation.basis.length : 0;
  return `确认人 ${confirmation.identity} · ${new Date(confirmation.confirmedAt).toLocaleString()} · 依据 ${basis} 项产物`;
}
const pendingKey='workbench-request:'+props.projectId+':'+props.canvasId+(props.nodeId?':'+props.nodeId:'');
const lastRunKey='workbench-last:'+pendingKey;
let published = "";
const outputPending = ref(false);
async function publishResult(){
  const attempt = nodeAttempt.value;
  if (attempt?.state !== "succeeded" || !attempt.outputText || !props.saveResult || published === attempt.id) return;
  published = attempt.id;
  try { await props.saveResult({attemptId:attempt.id,text:attempt.outputText}); outputPending.value=false; }
  catch (cause) { published=""; outputPending.value=true; throw cause; }
}
const editionKey='workbench-trigger:'+props.projectId+':'+props.canvasId;
const today=new Date(),editionDate=ref(`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`),editionLabel=ref("");
const editionRequest=ref<EditionRequest>(),acceptedEdition=ref<EditionResult>();
let after=0,events:EventSource|undefined,disposed=false,epoch=0,historyEpoch=0,actionEpoch=0;
let refreshFlight:Promise<void>|undefined,refreshKey="",controller:AbortController|undefined;
let refreshAgain = false;
let historyFlight:{key:string;promise:Promise<void>}|undefined;
const belongs=(result:Run)=>{if(result.projectId!==props.projectId||result.canvasId!==props.canvasId)throw new Error("运行不属于当前画布。");return result;};
class ApiError extends Error { constructor(message:string,readonly status:number){super(message);} }
async function api<T>(url:string,method="GET",body?:unknown,signal?:AbortSignal):Promise<T>{const response=await fetch(url,{method,headers:{"content-type":"application/json"},signal:signal ?? (method==="GET" ? AbortSignal.timeout(10000) : undefined),...(body===undefined?{}:{body:JSON.stringify(body)})});const result=await response.json();if(!response.ok)throw new ApiError(result.message||"运行请求失败。",response.status);return result;}
async function action(fn:()=>Promise<unknown>){if(busy.value||disposed)return;const token=++actionEpoch;busy.value=true;error.value="";try{await fn();}catch(cause){if(!disposed&&token===actionEpoch&&!(cause instanceof Error&&cause.name==="AbortError"))error.value=cause instanceof Error?cause.message:String(cause);}finally{if(!disposed&&token===actionEpoch)busy.value=false;}}
function invalidate(){epoch++;controller?.abort();refreshAgain=false;refreshFlight=undefined;refreshKey="";logsLoading.value=false;}
function clearLogs(){entries.value=[];after=0;logsAtEnd.value=false;}
function locate(id:string){if(props.nodeId){try{sessionStorage.setItem(lastRunKey,id);}catch{}return;}const url=new URL(location.href);url.searchParams.set('run',id);window.history.replaceState(null,'',url);}
function keepRequest(value:Request|undefined){request.value=value;try{if(value)sessionStorage.setItem(pendingKey,JSON.stringify(value));else sessionStorage.removeItem(pendingKey);}catch{}}
function keepEdition(value:EditionRequest|undefined){editionRequest.value=value;try{if(value)sessionStorage.setItem(editionKey,JSON.stringify(value));else sessionStorage.removeItem(editionKey);}catch{}}
async function triggerEdition(){
  if(props.dirty)throw new Error("请先保存模板画布。");if(request.value)throw new Error("请先核对未决运行请求。");
  if(!editionRequest.value){const date=editionDate.value;if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)throw new Error("请选择有效的期次日期。");keepEdition({id:browserUuid(),date,...(editionLabel.value.trim()?{label:editionLabel.value.trim()}:{}),concurrency:concurrency.value});}
  const original=editionRequest.value!,result=await api<EditionResult>(`/api/video/v2/projects/${props.projectId}/canvases/${props.canvasId}/trigger`,"POST",original);
  if(disposed)return;if(result.trigger.phase!=="accepted"||result.trigger.id!==original.id||result.trigger.date!==original.date||result.trigger.projectId!==props.projectId||result.trigger.templateId!==props.canvasId||result.trigger.canvasId!==result.run.canvasId||result.trigger.runId!==result.run.id||result.run.projectId!==props.projectId)throw new Error("期次回执与原请求不一致，请保留原请求继续核对。");
  acceptedEdition.value=result;keepEdition(undefined);emit("edition",result.trigger.canvasId,result.run.id);
}
async function readLatest(token:number,id:string,signal:AbortSignal){
  const result=await api<Run>(`/api/video/v2/runs/${id}`,"GET",undefined,signal);
  if(disposed||token!==epoch)return;belongs(result);run.value=result;
  if(props.nodeId){await publishResult();return;}
  const position=after,page=await api<{entries:typeof entries.value;nextCursor:number}>(`/api/video/v2/runs/${id}/logs?after=${position}&limit=100`,"GET",undefined,signal);
  if(disposed||token!==epoch||run.value?.id!==id)return;
  entries.value=[...new Map([...entries.value,...page.entries].map(row=>[row.sequence,row])).values()].slice(-500);
  after=page.nextCursor;logsAtEnd.value=page.entries.length<100;
}
function refresh(changed = false){
  if(disposed)return Promise.resolve();const id=request.value?.id||run.value?.id;if(!id)return Promise.resolve();
  const token=epoch,key=`${token}:${id}`;
  if (refreshFlight && refreshKey === key) {
    refreshAgain ||= changed;
    return refreshFlight;
  }
  const next=new AbortController();controller=next;logsLoading.value=true;refreshKey=key;
  const signal = AbortSignal.any([next.signal, AbortSignal.timeout(10000)]);
  const flight = readLatest(token,id,signal).finally(() => {
    if (refreshFlight !== flight) return;
    refreshFlight = undefined;
    logsLoading.value = false;
    if (refreshAgain) {
      refreshAgain = false;
      refreshInBackground();
    }
  });
  refreshFlight=flight;return flight;
}
function refreshInBackground(changed = false) {
  void refresh(changed).catch(cause => {
    if (!disposed && !(cause instanceof Error && cause.name === "AbortError")) error.value = String(cause);
  });
}
async function restartLogs(){invalidate();clearLogs();await refresh();}
async function loadHistory(next=false){
  const cursor=next?historyCursor.value:null,key=cursor||"first";if(next&&!cursor)return;if(historyFlight?.key===key)return historyFlight.promise;
  const token=++historyEpoch,query=new URLSearchParams({limit:'20'});if(cursor)query.set('cursor',cursor);
  const flight=(async()=>{const result=await api<{runs:typeof history.value;nextCursor:string|null}>(`/api/video/v2/projects/${props.projectId}/canvases/${props.canvasId}/runs?${query}`);if(disposed||token!==historyEpoch)return;history.value=next?mergePage(history.value,result.runs).rows:result.runs;historyCursor.value=result.nextCursor;})();historyFlight={key,promise:flight};try{await flight;}finally{if(token===historyEpoch)historyFlight=undefined;}
}
async function openRun(id:string){if(request.value)throw new Error('请先核对未决运行请求。');invalidate();const token=epoch,result=await api<Run>(`/api/video/v2/runs/${id}`);if(disposed||token!==epoch)return;belongs(result);run.value=result;clearLogs();locate(id);await refresh();}
async function start(resume=false){
  if(!props.nodeId && props.dirty)throw new Error("请先保存画布。");
  if(editionRequest.value)throw new Error("请先恢复原期次请求。");
  if(!request.value){
    const revision=props.saveBeforeRun ? await props.saveBeforeRun() : props.revision;
    if(disposed)return;
    keepRequest({id:browserUuid(),revision,concurrency:concurrency.value,...(props.nodeId?{nodeId:props.nodeId}:{}),...(resume&&run.value?{resumeRunId:run.value.id}:{})});
  }
  const original=request.value!;
  invalidate();const token=epoch;run.value=undefined;clearLogs();outputPending.value=false;
  if(!props.nodeId)locate(original.id);
  try{
    const result=await api<Run>(`/api/video/v2/projects/${props.projectId}/canvases/${props.canvasId}/runs`,"POST",original);
    if(disposed||token!==epoch)return;
    belongs(result);run.value=result;locate(result.id);keepRequest(undefined);
  }catch(cause){
    if(props.nodeId&&!disposed&&token===epoch&&cause instanceof ApiError&&[400,403,404,409,423].includes(cause.status))keepRequest(undefined);
    throw cause;
  }
  await refresh();
}
async function cancel(){if(!run.value)return;const id=run.value.id;invalidate();const token=epoch,result=await api<Run>(`/api/video/v2/runs/${id}/cancel`,"POST");if(!disposed&&token===epoch)run.value=belongs(result);}
async function reconcile(){if(!run.value)return;const id=run.value.id;invalidate();const token=epoch;await api(`/api/video/v2/runs/${id}/refresh`,"POST");if(!disposed&&token===epoch)await refresh(true);}
async function complete(attempt:Attempt,withEvidence=false){if(!run.value)return;const id=run.value.id,body:Record<string,unknown>={nodeId:attempt.nodeId,attemptId:attempt.id,identity:identity.value.trim()};if(withEvidence)body.evidence=JSON.parse(evidence.value);invalidate();const token=epoch;await api(`/api/video/v2/runs/${id}/complete`,"POST",body);if(!disposed&&token===epoch)await refresh(true);}
function instructions(id:string){return run.value?.snapshot?.graph.nodes.find(node=>node.id===id)?.config.instructions;}
async function refreshPrevious(id:string){
  const token=epoch,result=await api<Run>(`/api/video/v2/runs/${id}`);
  if(disposed||token!==epoch)return;
  run.value=belongs(result);
  if(props.nodeId&&request.value?.id===id){locate(id);keepRequest(undefined);}
  await refresh();
}
onMounted(()=>{
  try{const pending=sessionStorage.getItem(pendingKey);if(pending){const parsed=JSON.parse(pending);if(typeof parsed.id==="string"&&Number.isSafeInteger(parsed.revision))request.value=parsed;}const pendingEdition=sessionStorage.getItem(editionKey);if(pendingEdition){const parsed=JSON.parse(pendingEdition);if(typeof parsed.id==="string"&&typeof parsed.date==="string")editionRequest.value=parsed;}}catch{}
  if (!props.nodeId) void loadHistory().catch(cause => { if (!disposed) error.value = String(cause); });
  void action(async()=>{
    if(disposed)return;
    const id=request.value?.id||(props.nodeId?sessionStorage.getItem(lastRunKey):new URL(location.href).searchParams.get('run'));
    if(!id)return;
    try{
      await refreshPrevious(id);
    }catch(cause){
      if(!(props.nodeId&&cause instanceof ApiError&&cause.status===404))throw cause;
    }
  });
  events = managerEventSource("/api/events");
  events.addEventListener("plugin_event", event => {
    if (disposed) return;
    try {
      const payload = JSON.parse((event as MessageEvent).data);
      const value = payload.data?.instanceId ? payload.data : payload;
      if (value.name === "workbench.changed" && value.data?.runId === (run.value?.id || (!busy.value ? request.value?.id : undefined))) refreshInBackground(true);
    } catch { error.value = "运行事件读取失败，请查询原运行。"; }
  });
  events.onopen = () => { if (run.value && !terminal.has(run.value.state)) refreshInBackground(); };
});
onBeforeUnmount(()=>{disposed=true;epoch++;historyEpoch++;actionEpoch++;controller?.abort();events?.close();});
</script>
<template>
  <section v-if="nodeId" class="node-run-controls">
    <span v-if="run" role="status">{{runLabel}}</span>
    <button v-if="run && !terminal.has(run.state)" type="button" class="node-run-check" :disabled="busy" @click="action(reconcile)">刷新状态</button>
    <button v-if="outputPending" type="button" class="node-run-check" :disabled="busy" @click="action(publishResult)">保存结果</button>
    <v-btn v-if="request || !run || terminal.has(run.state)" icon="mdi-arrow-up" size="x-small" color="white" :aria-label="request ? '恢复原请求' : '生成文本'" :title="request ? '恢复原请求' : '生成文本'" :loading="busy" :disabled="busy || (!request && !canRun)" @click="action(()=>start())"/>
    <p v-if="error || nodeAttempt?.reason" class="node-run-message" role="status">{{error || nodeAttempt?.reason}}</p>
  </section>
  <section v-else class="run-panel">
    <div class="edition-toolbar"><span>按期次运行</span><label>日期<input v-model="editionDate" aria-label="期次日期" type="date" :disabled="!!editionRequest||busy"/></label><input v-model="editionLabel" class="edition-label" aria-label="期次名称" placeholder="期次名称（可选）" :disabled="!!editionRequest||busy"/><v-btn :disabled="busy||dirty||!!request" size="small" variant="tonal" @click="action(triggerEdition)">{{editionRequest?'恢复原期次请求':'创建并运行期次'}}</v-btn><small v-if="editionRequest">原请求日期：{{editionRequest.date}}</small><v-btn v-if="acceptedEdition" size="small" variant="text" @click="emit('edition',acceptedEdition.trigger.canvasId,acceptedEdition.run.id)">打开本期画布</v-btn></div>
    <div class="run-toolbar"><div class="run-heading"><small>执行</small><strong v-if="run" :class="run.state">{{runLabel}}</strong><strong v-else>准备运行</strong></div><v-btn :disabled="busy||dirty||!!editionRequest" color="primary" @click="action(()=>start())">{{request?'恢复原运行请求':'运行画布'}}</v-btn><label>并发<input v-model.number="concurrency" aria-label="运行并发数量" type="number" min="1" max="16"/></label><v-btn v-if="run" :disabled="busy||dirty||!!request" variant="tonal" @click="action(()=>start(true))">续跑</v-btn><v-btn v-if="run||request" :disabled="busy" variant="text" @click="action(refresh)">查询原运行</v-btn><v-btn v-if="run" :disabled="busy" variant="text" @click="action(reconcile)">核对原执行</v-btn><v-btn v-if="run&&!['succeeded','failed','cancelled','completed_with_errors'].includes(run.state)" :disabled="busy" color="error" variant="text" @click="action(cancel)">停止</v-btn></div>
    <v-alert v-if="error" type="error" variant="tonal">{{error}}</v-alert><p v-if="request" class="pending-request">原运行请求尚未确认。恢复时沿用同一请求，不创建第二次运行。</p><p v-if="run?.reason" class="run-reason">{{run.reason}}</p>
    <div v-if="run" class="run-results"><article v-for="attempt in run.attempts" :key="attempt.id"><div class="attempt-main"><i class="status-dot" :class="attempt.state"/><span>{{attempt.title||attempt.nodeId}}</span><strong :class="attempt.state">{{attemptLabel(attempt)}}</strong><small v-if="attempt.reusedFromAttemptId">复用已核验产物</small><small v-if="confirmationNote(attempt)" class="attempt-confirmation">{{confirmationNote(attempt)}}</small><a v-for="artifact in attempt.artifacts" :key="artifact.artifactId" :href="'/api/video/v2/runs/'+run.id+'/artifacts?artifact='+artifact.artifactId" target="_blank" rel="noopener">{{artifact.key}} · {{artifact.bytes}} B ↗</a><v-btn v-if="waitingApproval(attempt)" :disabled="!identity.trim()||busy" size="small" color="primary" @click="action(()=>complete(attempt))">确认并继续</v-btn><template v-else-if="waitingHuman(attempt)"><v-btn :disabled="!identity.trim()||busy" size="small" color="primary" @click="action(()=>complete(attempt))">标记完成并继续</v-btn><v-btn :disabled="!identity.trim()||!evidenceReady||busy" size="small" variant="tonal" @click="action(()=>complete(attempt,true))">提交检查</v-btn></template></div><p v-if="instructions(attempt.nodeId)" class="run-reason">{{instructions(attempt.nodeId)}}</p><small v-if="attempt.reason" class="attempt-reason">{{attempt.approval?.required&&waitingStates.has(attempt.state)?'此节点需人工确认后才继续':attempt.reason}}</small></article></div>
    <div v-if="run&&pendingHumans.length" class="human-evidence"><v-text-field v-model="identity" label="确认人" hide-details/><v-textarea v-if="pendingHumans.some(attempt=>attempt.approval?.required!==true)" v-model="evidence" label="检查证据（JSON，选填）" rows="3" hide-details/></div>
    <pre v-if="entries.length" class="run-log">{{entries.map(row=>`${row.sequence} [${row.stream}] ${row.text}`).join('\n')}}</pre><div v-if="run" class="run-toolbar log-controls"><v-btn :disabled="busy||logsLoading||logsAtEnd" size="small" variant="text" @click="action(refresh)">{{logsAtEnd?'已读取到日志末尾':'继续读取日志'}}</v-btn><v-btn :disabled="busy||logsLoading" size="small" variant="text" @click="action(restartLogs)">从头读取日志</v-btn><small v-if="entries.length">第 {{entries[0].sequence}}–{{entries[entries.length-1].sequence}} 条 · 最多显示最近 500 条</small></div>
    <details class="run-history"><summary @click="action(()=>loadHistory())">运行历史</summary><div v-for="row in history" :key="row.id"><button :disabled="busy||!!request" @click="action(()=>openRun(row.id))"><span>{{new Date(row.createdAt).toLocaleString()}}</span><strong>{{runStates?.[row.state]?.label||row.state}}</strong><small>画布修订 {{row.canvasRevision}}</small></button></div><v-btn v-if="historyCursor" :disabled="busy" size="small" @click="action(()=>loadHistory(true))">下一页</v-btn></details>
  </section>
</template>
<style scoped>.edition-toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;border-bottom:1px solid #30434f;padding-bottom:14px;margin-bottom:14px;font-size:12px;color:#a5b9c6}.edition-toolbar>span{color:#c1d8d5;margin-right:6px}.edition-toolbar label{display:flex;align-items:center;gap:8px}.edition-toolbar input{padding:7px 10px;color:#eaf1f6;background:#192630;border:1px solid #405363;border-radius:6px;font:inherit}.edition-toolbar input:disabled{opacity:.6}.edition-label{max-width:180px}</style>
<style scoped>.run-panel{border-top:1px solid var(--wb-border,#30434f);padding:16px 24px;background:#101a22}.run-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.run-heading{display:flex;flex-direction:column;min-width:100px;gap:4px}.run-heading>small{color:#93a8b7;font-size:10px;letter-spacing:2px}.run-heading>strong{font-size:13px;font-weight:550}.run-toolbar>label{font-size:12px;color:#9baebc;margin:0 8px}.run-toolbar input{width:52px;margin-left:8px;border:1px solid #344e5b;border-radius:5px;padding:6px;color:inherit;background:#192630}.run-results{max-height:280px;overflow:auto;margin-top:14px}.run-results>article{padding:10px 0;border-bottom:1px solid #2c404c}.attempt-main{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.attempt-main>span{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.attempt-main>strong{font-size:11px;font-weight:500;border:1px solid #3d5965;padding:2px 8px;border-radius:20px;color:#acbdc8}.attempt-main a{font-size:12px;color:#a5dacf;text-decoration:none;border-bottom:1px solid #3d6963}.attempt-main small,.attempt-reason{color:#a7b6c3;font-size:11px}.attempt-reason{display:block;margin:7px 24px}.status-dot{width:7px;height:7px;background:#6c8593;border-radius:50%;flex-shrink:0}.status-dot.succeeded{background:#89dbc7}.status-dot.failed{background:#e9958a}.status-dot.waiting_human,.status-dot.waiting_approval,.status-dot.waiting_agent{background:#dfc58f}.run-heading .succeeded{color:#89dbc7}.run-heading .failed{color:#e9958a}.run-log{max-height:200px;overflow:auto;background:#0b1319;padding:14px;white-space:pre-wrap;font:11px/1.8 ui-monospace,monospace;margin-top:14px;border:1px solid #2c404c;border-radius:6px}.human-evidence{display:flex;gap:12px;max-width:760px;margin-top:16px}.human-evidence>:first-child{max-width:220px}.run-history{margin-top:18px;font-size:12px;color:#a5b7c4}.run-history summary{cursor:pointer}.run-history>div{border-bottom:1px solid #2c404c}.run-history button{display:flex;gap:24px;align-items:center;width:100%;padding:12px 0;text-align:left}.run-history strong{font-weight:500}.run-history small{margin-left:auto;color:#829aa9}.run-reason,.pending-request{font-size:12px;color:#cab680;margin:10px 0;white-space:pre-wrap}.log-controls{margin-top:6px}.log-controls small{color:#8ea5b4;font-size:11px}button:focus-visible{outline:2px solid #89dbc7;outline-offset:3px}@media(max-width:800px){.human-evidence{flex-direction:column}.human-evidence>:first-child{max-width:none}}</style>

<style scoped>
.node-run-controls { display:flex; flex-wrap:wrap; align-items:center; justify-content:flex-end; gap:8px; color:var(--rr-muted); font-size:12px; }
.node-run-check { color:var(--rr-text); padding:4px 8px; border-radius:6px; background:var(--rr-surface-raised,var(--rr-surface)); }
.node-run-message { flex-basis:100%; margin:0; overflow-wrap:anywhere; color:var(--wb-text); }
</style>
