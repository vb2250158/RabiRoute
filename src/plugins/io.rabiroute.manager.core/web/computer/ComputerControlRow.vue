<script setup lang="ts">
import { useI18n } from "../../../../../ribiwebgui/src/i18n/index";
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import type { ComputerControlEvents } from "./computerControlEvents";
import type { ComputerControlClient } from "./computerControlClient";
import { createComputerControlState } from "./computerControlState";
import { type ComputerTarget, type ComputerFieldSchema, writeField } from "./computerControlPresentation";
import { COMPUTER_ACTIONS, isComputerReadOnlyAction } from "@shared/agentInteractiveProtocol";
import { browserUuid } from "../../../../../ribiwebgui/src/browserUuid";
import { managerAccessToken } from "../../../../../ribiwebgui/src/managerApi";
import { userFacingError } from "../../../../../ribiwebgui/src/userFacingError";
import ComputerControlSchemaFields from "./ComputerControlSchemaFields.vue";
import ComputerControlObservation from "./ComputerControlObservation.vue";
import ComputerControlInput from "./ComputerControlInput.vue";
import ComputerControlCanvas from "./ComputerControlCanvas.vue";
import ComputerControlFiles from "./ComputerControlFiles.vue";
import ComputerControlActionForm from "./ComputerControlActionForm.vue";
import RemoteTerminalDialog from "../../../../../ribiwebgui/src/components/RemoteTerminalDialog.vue";
const { t } = useI18n();
const props = defineProps<{ target: ComputerTarget; expanded: boolean; active: boolean; client: ComputerControlClient; events?:ComputerControlEvents }>();
const emit = defineEmits<{ toggle: [] }>();
const editor = createComputerControlState(reactive);
const draft = computed(() => editor.state.drafts.get(props.target.id));
const workReadAt=ref<number>();const workIssue=ref("");
const settingsError=ref("");
const loading = ref(false); const busy = ref(""); const error = ref(""); const receipt = ref<Record<string, unknown>>();
const activity = computed(() => control.value?.activity as Record<string, unknown> | undefined);
const activitySummary = computed(() => {
  const labels: Record<string, string> = {
    capturing: "正在获取画面", prepared: "图像已准备，模型送达待确认", provided: "已提供给模型",
    operating: "正在操作", returning: "正在归还鼠标和前台", returned: "本批次操作已结束",
    tracking: "正在跟踪目标", stopped: "本次操作已停止", failed: "本次操作需要处理", ready: "控制已就绪"
  };
  return activity.value ? t(labels[String(activity.value.phase)] || "状态待确认") : "";
});
const returnResult = computed(() => {
  const value = activity.value ? activity.value.returnState : receipt.value?.returnState;
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
});
function returnDescription(value: unknown): string {
  const state = value && typeof value === "object" ? (value as Record<string, unknown>).state : value;
  const labels: Record<string, string> = {
    restored: "已归还", returned: "已归还", released: "已释放", yielded: "已让出给用户",
    unchanged: "保持用户当前选择", skipped: "保持用户当前选择", partial: "部分完成",
    failed: "归还失败", unavailable: "无法归还", pending: "归还待确认", disabled: "归还已关闭"
  };
  return t(labels[String(state)] || "状态待确认");
}
const windows = ref<Record<string,unknown>[]>([]);
const displays = ref<Record<string, unknown>[]>([]);
const foregroundDisplayId = ref<string>();
const displayLayoutRevision = ref<string>();
const control = ref<Record<string, unknown>>(); const terminal = ref(false); const image = ref<Record<string, unknown>>();
const knownLayers = ref<Record<string, unknown>[]>([]); const knownTracking = ref<Record<string, unknown>[]>([]);
const layer = ref<Record<string, unknown>>(); const tracking = ref<Record<string, unknown>>();
const inputRequestId = ref("");
const lastRequest = ref<Record<string, unknown>>();
const laneVersions = new Map<string,number>(); const pending = new Map<string,{sequence:number;action:string}>();
const laneFor = (action:string) => action.startsWith("annotation.track.") ? "tracking" : action.split(".")[0]!;
let workLoaded = false;let workSequence=0;let workController:AbortController|undefined;let workUnsubscribe:(()=>void)|undefined;let workScheduled=false;
let disposed = false; let readRevision = 0; let readController: AbortController | undefined; let actionRevision = 0; let observationRevision = 0;
const located = computed(() => !!props.target.instanceId);
const connected = computed(() => props.target.status === "online");
const settings = computed(() => draft.value?.value ?? props.target.computerSettings ?? {});
const enabled = computed(() => typeof settings.value.enabled === "boolean" ? settings.value.enabled : props.target.enabled !== false);
const features = computed(() => (settings.value.features || {}) as Record<string, unknown>);
const sessionId = computed(() => typeof control.value?.controlSessionId === "string" ? control.value.controlSessionId : "");
const hasControlSession = computed(() => !!sessionId.value && !["ended", "idle", "closed", "absent"].includes(String(control.value?.state || control.value?.status)));
const controlling = computed(() => !!sessionId.value && (control.value?.state || control.value?.status) === "active");
const controlSummary=computed(()=>{const state=String(control.value?.state || control.value?.status);return state === "starting" ? t("正在进入控制") : ["ending","stopping"].includes(state) ? t("正在退出控制") : controlling.value ? t("正在控制") : hasControlSession.value ? t("控制状态待确认") : t("未在控制");});
const screenshotUrl = computed(() => image.value?.data && image.value?.mimeType ? `data:${image.value.mimeType};base64,${image.value.data}` : "");
const trackingRows = computed(() => {const rows=new Map(knownTracking.value.map(value=>[value.trackingId,value]));if(tracking.value)rows.set(tracking.value.trackingId,tracking.value);return [...rows.values()];});
const trackingActive=computed(()=>trackingRows.value.some(value=>["tracking","running"].includes(String(value.state))));
const hasTrackingWork=computed(()=>trackingRows.value.some(value=>typeof value.trackingId === "string" && !["stopped","expired","absent"].includes(String(value.state))));
const trackingSummary=computed(()=>{const labels:Record<string,string>={tracking:"跟踪中",running:"跟踪中",lost:"跟踪目标丢失",ambiguous:"跟踪目标不明确",paused:"跟踪已暂停",stopping:"正在停止跟踪",uncertain:"跟踪状态待确认",failed:"跟踪失败",stopped:"跟踪已停止",expired:"跟踪已到期",absent:"当前没有该工作"};return [...new Set(trackingRows.value.map(value=>t(labels[String(value.state)] || String(value.state))))].join(" / ");});
const workResult = computed(() => ({injected:"输入已注入；应用效果尚未验证",running:"正在执行",cancelled:"剩余动作已取消",uncertain:"结果待确认",failed:"执行失败",visible:"标注已显示",cleared:"标注已清除",stopped:"跟踪已停止",active:"正在控制",ended:"控制已退出",absent:"当前没有该工作"}[String(receipt.value?.state)] || ""));
function available(feature: string) { if(!located.value)return false;if(feature === "terminal")return props.target.terminalShells?.length !== 0; if(!props.target.capabilities)return !["input","annotation"].includes(feature);return Object.values(COMPUTER_ACTIONS).some(definition=>definition.feature === feature && props.target.capabilities!.includes(definition.capability)); }

const settingSchema = computed(() => draft.value?.saved.schema as ComputerFieldSchema | undefined);
const labels = [ { id:"terminal", title:"终端命令", icon:"mdi-console" }, {id:"files",title:"文件操作",icon:"mdi-folder-outline"}, {id:"observation",title:"窗口与截图",icon:"mdi-monitor-screenshot"}, {id:"agentTasks",title:"智能体任务",icon:"mdi-robot-outline"}, {id:"input",title:"鼠标与键盘",icon:"mdi-mouse"}, {id:"annotation",title:"屏幕标注",icon:"mdi-vector-square"} ];

const settingsDiagnostics = computed(() => {
  const values=draft.value?.saved.diagnostics;
  return Array.isArray(values)?values.map(value=>String(value?.field||"")+" · "+String(value?.message||"")).join("\n"):"";
});
const defaultPaths = computed(() => {
  const paths:string[]=[];
  const visit=(schema:ComputerFieldSchema,prefix:string)=>{
    if(schema.type==="object"&&schema.properties)for(const [key,value]of Object.entries(schema.properties))visit(value as ComputerFieldSchema,prefix?prefix+"."+key:key);
    else if(prefix)paths.push(prefix);
  };
  if(settingSchema.value)visit(settingSchema.value,"");
  return paths;
});
async function restoreDefaults() {
  const current=draft.value;
  if(!current||current.saving||!defaultPaths.value.length)return;
  await editor.save(props.target.id,{},(_body,etag)=>props.client.resetSettings(props.target,defaultPaths.value,etag));
  if(current.conflict)await loadSettings();
}

async function loadSettings() {
  if (!located.value) return;
  const revision = ++readRevision; readController?.abort(); readController = new AbortController(); loading.value = true; settingsError.value="";
  try { const result = await props.client.settings(props.target, readController.signal); if (!disposed && revision === readRevision) { editor.acceptSettings(props.target.id, result); } }
  catch (reason) { if (!disposed && revision === readRevision) settingsError.value = userFacingError(reason); }
  finally { if (!disposed && revision === readRevision) loading.value = false; }
}
function edit(path: string[], value: unknown) {
  const current = draft.value; if (!current) return;
  current.value = writeField(current.value, path, value); current.changes.set(path.join("."), value); current.revision++;
  void save();
  if (path.join(".") === "features.observation" && value === false || path.length === 1 && path[0] === "enabled" && value === false) { image.value = undefined; ++observationRevision; }
}
async function save(manual=false) {
  const current = draft.value; if (!current || current.saving || current.readbackUnconfirmed && !manual) return;
  let patch: Record<string, unknown> = {};
  for (const [path, value] of current.changes) patch = writeField(patch, path.split("."), value);
  await editor.save(props.target.id, patch, (body, etag) => props.client.saveSettings(props.target, body, etag));
  if (current.conflict) await loadSettings();
  else if (!current.error && !current.readbackUnconfirmed && current.changes.size && !disposed) void save();
}
async function run(body: Record<string, unknown>) {
  if (!located.value) return;
  const action = String(body.action); const lane=laneFor(action); const recovery=["control.end","input.cancel","annotation.clear","annotation.track.stop"].includes(action);
  if (pending.has(lane) && !recovery) return;
  const sequence=(laneVersions.get(lane)||0)+1;laneVersions.set(lane,sequence);pending.set(lane,{sequence,action});
  const captureRevision = observationRevision; const request = { ...body }; ++actionRevision;
  if (["control.begin", "input.execute", "annotation.show", "annotation.update", "annotation.track.start"].includes(action)) request.requestId ||= browserUuid();
  if (["control.end", "input.execute"].includes(action) && sessionId.value) request.controlSessionId = sessionId.value;
  if (["input.execute", "annotation.show", "annotation.track.start"].includes(action) && !request.source && image.value?.source) request.source = image.value.source;
  if (action === "input.execute") inputRequestId.value = String(request.requestId);
  busy.value = action; error.value = ""; lastRequest.value = request;
  try {
    const result = await props.client.action(props.target, request);
    if (disposed || sequence !== laneVersions.get(lane)) return;
    receipt.value = result;
    if(action === "windows.list" && Array.isArray(result.windows))windows.value=result.windows;
    if (action === "displays.list" && Array.isArray(result.displays)) {
      displays.value = result.displays as Record<string, unknown>[];
      foregroundDisplayId.value = typeof result.foregroundDisplayId === "string" ? result.foregroundDisplayId : undefined;
      displayLayoutRevision.value = typeof result.layoutRevision === "string" ? result.layoutRevision : undefined;
    }
    if (action.startsWith("control.")) {control.value = result;workReadAt.value=Date.now();}
    if (action.startsWith("annotation.track.")) tracking.value = result;
    else if (action.startsWith("annotation.")) layer.value = result;
    const capture = action === "screen.capture" ? result : result.capture;
    if (captureRevision === observationRevision && capture && typeof capture === "object" && features.value.observation !== false && enabled.value) image.value = capture as Record<string, unknown>;
  } catch (reason) { if (!disposed && sequence === laneVersions.get(lane)) error.value = isComputerReadOnlyAction(action) ? userFacingError(reason) : `${userFacingError(reason)}；可查询原操作状态，未自动重发。`; }
  finally { if (!disposed && sequence === laneVersions.get(lane)) {pending.delete(lane);busy.value=Array.from(pending.values()).at(-1)?.action || "";} }
}
async function stopTracking() { const ids = new Set(trackingRows.value.filter(value=>!["stopped","expired","absent"].includes(String(value.state))).map(value=>value.trackingId).filter(value=>typeof value==="string")); for (const trackingId of ids) await run({action:"annotation.track.stop",trackingId}); }
function clearAllLayers() { void run({action:"annotation.clear"}); }
function clearLayer() { if (layer.value?.layerId || tracking.value?.layerId) void run({ action:"annotation.clear", layerId:layer.value?.layerId || tracking.value?.layerId }); }
function invalidateObservation() { image.value=undefined;++observationRevision; }
function refreshWork() { workLoaded=false;void loadWork(); }
function invalidateWork() {
 workLoaded=false;++workSequence;workController?.abort();
 if(workScheduled)return;workScheduled=true;queueMicrotask(()=>{workScheduled=false;if(!disposed&&props.active&&props.expanded)void loadWork();});
}
function openTerminal() { terminal.value=true; }
function endControl() { void run({ action:"control.end", controlSessionId:sessionId.value }); }
async function loadWork() {
 if (workLoaded || !connected.value || !located.value) return; workLoaded = true; const revision = actionRevision;const sequence=++workSequence;workController?.abort();const controller=new AbortController();workController=controller;workIssue.value="";
 const results = await Promise.allSettled([available("input") || available("observation") || sessionId.value ? props.client.action(props.target,{action:"control.status"},controller.signal) : Promise.resolve(undefined), available("annotation") || knownLayers.value.length || layer.value || tracking.value ? props.client.action(props.target,{action:"annotation.status"},controller.signal) : Promise.resolve(undefined)]);
 if (disposed || revision !== actionRevision || sequence !== workSequence || controller.signal.aborted) return;
 if(results.some(value=>value.status === "rejected"))workIssue.value=t("工作状态暂未更新；保留上次读取的状态。");
 if (results[0]?.status === "fulfilled" && results[0].value) {control.value = results[0].value;workReadAt.value=Date.now();}
 if (results[1]?.status === "fulfilled" && results[1].value) { const result=results[1].value; const layers=Array.isArray(result.layers)?result.layers as Record<string,unknown>[]:result.layerId?[result]:[];knownLayers.value=layers;if(layers[0])layer.value=layers[0];
   const retained=[...knownTracking.value,...(tracking.value?[tracking.value]:[])];const ids=[...new Set([...layers.map(value=>value.trackingId),...retained.filter(value=>!["stopped","expired","failed","absent"].includes(String(value.state))).map(value=>value.trackingId)].filter((value):value is string=>typeof value === "string"))];
   const statuses=await Promise.allSettled(ids.map(trackingId=>props.client.action(props.target,{action:"annotation.track.status",trackingId},controller.signal)));
   if(!disposed && revision === actionRevision && sequence === workSequence && !controller.signal.aborted){knownTracking.value=statuses.flatMap((value,index)=>value.status==="fulfilled"?[{trackingId:ids[index],...value.value}]:retained.filter(old=>old.trackingId===ids[index]));if(tracking.value?.trackingId){const current=knownTracking.value.find(value=>value.trackingId===tracking.value?.trackingId);if(current)tracking.value=current;}}
 }
}
watch([()=>props.expanded,()=>props.active,()=>props.target.id,()=>props.target.ownerDeviceId],([expanded,active])=>{
 workUnsubscribe?.();workUnsubscribe=undefined;workLoaded=false;++workSequence;workController?.abort();
 if(expanded && active){if(!draft.value)void loadSettings();workUnsubscribe=props.events?.subscribe(props.target,invalidateWork);void loadWork();}
 else invalidateObservation();
},{immediate:true});
watch(() => props.target.id, () => { ++actionRevision;++observationRevision;for(const [lane,version]of laneVersions)laneVersions.set(lane,version+1);pending.clear();busy.value="";image.value = undefined; control.value = undefined; receipt.value = undefined; readController?.abort(); });
onBeforeUnmount(() => { disposed = true; ++readRevision; ++actionRevision; readController?.abort(); ++workSequence;workController?.abort();workUnsubscribe?.();editor.dispose(); });
</script>
<template>
  <article class="computer-row" :data-computer-id="target.id">
    <header class="computer-summary"><button class="computer-expand" type="button" :aria-expanded="expanded" @click="emit('toggle')"><v-icon :icon="expanded ? 'mdi-chevron-down' : 'mdi-chevron-right'" /><span>{{ target.name }}</span></button><div class="computer-tags"><v-chip size="small" variant="outlined">{{ target.kind === 'host' ? t('主机') : t('远端节点') }}</v-chip><v-chip v-if="target.local" size="small" variant="tonal">{{ t('本机') }}</v-chip><v-chip size="small" :color="target.status === 'online' ? 'success' : target.status === 'unknown' ? 'warning' : 'default'">{{ target.status === 'online' ? t('在线') : target.status === 'offline' ? t('离线') : t('状态未知') }}</v-chip></div><span v-if="hasControlSession" class="current-work"><template v-if="!expanded || !active">{{ t('最近状态：') }}</template>{{ controlSummary }}</span><span v-if="trackingRows.length" class="current-work"><template v-if="!expanded || !active">{{ t('最近状态：') }}</template>{{ trackingSummary }}</span><v-btn v-if="hasTrackingWork" size="small" variant="text" @click="stopTracking">{{ t('停止跟踪') }}</v-btn><v-btn v-if="hasControlSession" size="small" variant="tonal" color="warning" :loading="busy === 'control.end'" @click="endControl">{{ t('退出控制') }}</v-btn></header>
    <div v-show="expanded" class="computer-details">
      <p v-if="!located" class="computer-note">{{ t('尚未取得此主机的执行实例。刷新连接目录后可读取设置；此条目没有猜测的执行目标。') }}</p>
      <p class="computer-note">{{ target.platform || t('系统未提供') }}<template v-if="target.ownerName">{{ t(' · 所属主机：') }}{{ target.ownerName }}</template></p>
      <v-alert v-if="target.issue" type="warning" variant="tonal">{{ target.issue }}{{ t(' · 最近信息保留，未将读取失败标记为离线。') }}</v-alert>
      <v-alert v-if="error" type="error" variant="tonal">{{ error }}</v-alert>
      <v-alert v-if="settingsError" type="warning" variant="tonal">{{ t('此电脑的设置暂不可用，已提供的操作仍可使用。') }} {{ settingsError }}</v-alert>
      <v-alert v-if="settingsDiagnostics" type="warning" variant="tonal">{{ t('部分设置需要修复；其他功能可继续使用。') }}<pre>{{ settingsDiagnostics }}</pre></v-alert>
      <p v-if="loading" role="status">{{ t('正在读取此电脑设置…') }}</p>
      <p v-if="hasControlSession && (!enabled || features.input === false)" role="status" class="computer-note">{{ t('关闭设置与执行停止分别确认；当前退出状态待回读，请刷新工作状态。') }}</p>
      <p v-if="workResult" class="computer-note" role="status">{{ workResult }}</p>
      <p v-if="workIssue" class="computer-note" role="status">{{ workIssue }}</p>
      <p v-if="workReadAt" class="computer-note">{{ t('最近状态读取：') }} {{ new Date(workReadAt).toLocaleTimeString() }} · {{ t('目标端退出后可刷新工作状态确认。') }}</p>
      <p v-if="activitySummary" role="status" class="computer-activity">{{ activitySummary }}<span v-if="activity?.sourceDisplay"> · {{ (activity.sourceDisplay as any).displayId }}</span></p>
      <section class="computer-work"><div><strong>{{ controlSummary }}</strong><span v-if="control?.source && (control.source as Record<string,unknown>).label"> · {{ (control.source as Record<string,unknown>).label }}</span><span v-if="control?.source && (control.source as Record<string,unknown>).taskId">{{ t(' · 关联任务（详情）') }}</span><p v-if="control?.remainingMs !== undefined" class="computer-note">{{ t('空闲退出剩余 ') }}{{ control.remainingMs === null ? t('已关闭') : Math.ceil(Number(control.remainingMs) / 1000) }}{{ t(' 秒 · ') }}{{ control.exitShortcut || t('快捷键状态未提供') }}</p><p v-if="control?.presentation" class="computer-note">{{ t('Agent 指针：') }}{{ (control.presentation as any)?.pointer ? t('已显示') : t('未显示') }}{{ t(' · 退出快捷键：') }}{{ (control.presentation as any)?.hotkey?.registered ? t('已注册') : (control.presentation as any)?.hotkey?.error || t('注册失败或冲突') }}</p></div><div class="work-buttons"><v-btn :disabled="!connected || !enabled || features.input === false || !available('input') || hasControlSession" :loading="busy === 'control.begin'" variant="tonal" @click="run({action:'control.begin',captureAfter:false})">{{ t('开始手动控制') }}</v-btn><v-btn :disabled="!hasControlSession" :loading="busy === 'control.end'" variant="tonal" @click="endControl">{{ t('退出控制') }}</v-btn><v-btn :disabled="!connected || !hasTrackingWork" :loading="busy === 'annotation.track.stop'" variant="text" @click="stopTracking">{{ t('停止跟踪') }}</v-btn><v-btn :disabled="!connected || !(layer?.layerId || tracking?.layerId)" :loading="busy === 'annotation.clear'" variant="text" @click="clearLayer">{{ t('清除标注') }}</v-btn><v-btn variant="text" :disabled="!connected" @click="refreshWork">{{ t('刷新工作状态') }}</v-btn><v-btn variant="text" :disabled="!connected || !(available('annotation') || knownLayers.length || layer?.layerId || tracking?.trackingId)" @click="clearAllLayers">{{ t('清除全部标注') }}</v-btn></div></section>
      <template v-if="draft && settingSchema">
        <v-switch :model-value="enabled" :label="t('启用此电脑')" :loading="draft.saving" @update:model-value="edit(['enabled'],$event)" />
      </template>
      <p class="computer-note">{{ t('终端和智能体也可能通过各自工具操作文件或鼠标键盘。') }}</p>
      <details v-for="feature in labels" :key="feature.id" class="computer-feature">
          <summary><v-icon :icon="feature.icon" /><h3>{{ t(feature.title) }}</h3><v-switch v-if="draft && settingSchema" :model-value="features[feature.id] !== false" :disabled="!enabled" hide-details density="compact" :aria-label="t(feature.title)" @click.stop @keydown.stop @update:model-value="edit(['features',feature.id],$event)" /></summary>
          <p v-if="feature.id !== 'agentTasks' && !available(feature.id)" class="computer-note">{{ t('此执行端尚未声明支持此功能，保存的开关选择仍保留。更新对应客户端后可刷新能力。') }}</p>
          <template v-if="feature.id === 'terminal'"><p class="computer-note">{{ t('Shell、工作目录、尺寸和会话输出使用原终端面板。') }}</p><v-btn variant="tonal" :disabled="!connected || !enabled || features.terminal === false || !available('terminal')" @click="openTerminal">{{ t('打开终端') }}</v-btn></template>
          <template v-else-if="feature.id === 'files'"><ComputerControlFiles :call="body => client.action(target,body)" :disabled="!connected || !enabled || features.files === false || !available('files')" /></template>
          <template v-else-if="feature.id === 'agentTasks'"><p class="computer-note">{{ t('任务绑定和执行程序继续使用原智能体配置。') }}</p><v-btn variant="tonal" :disabled="!located" :to="{path:'/rabilink',query:{tab:'agents',deviceId:target.ownerDeviceId || undefined,instanceId:target.instanceId}}">{{ t('前往此电脑的智能体任务配置') }}</v-btn></template>
          <template v-else-if="feature.id === 'observation'"><ComputerControlObservation :windows="windows" :displays="displays" :foreground-display-id="foregroundDisplayId" :layout-revision="displayLayoutRevision" :capabilities="target.capabilities" :disabled="!connected || !enabled || features.observation === false" :busy="!!busy" @source-change="invalidateObservation" @submit="run" /></template>
          <template v-else-if="feature.id === 'input'"><ComputerControlInput :session-id="controlling ? sessionId : ''" :request-id="inputRequestId" :disabled="!connected || !enabled || features.input === false || !available('input') || !controlling" :busy="!!busy" @submit="run" /></template>
          <template v-else><ComputerControlActionForm :capabilities="target.capabilities" :group="feature.id === 'input' ? 'input' : feature.id" :busy="!!busy" :disabled="!connected || !enabled || features[feature.id] === false || !available(feature.id)" @submit="run" /></template>
      </details>
      <template v-if="draft && settingSchema">
        <details class="computer-settings"><summary>{{ t('控制体验、标注与资源参数') }}</summary><ComputerControlSchemaFields :schema="{...settingSchema,properties:Object.fromEntries(Object.entries(settingSchema.properties || {}).filter(([key])=>!['enabled','features'].includes(key)))}" :model-value="draft.value" :disabled="!enabled" :disabled-paths="(settings.annotation as Record<string,unknown>)?.dynamicEnabled === true ? [] : ['annotation.backend','annotation.rateHz','annotation.tracking']" @change="edit" /><p class="computer-note">{{ t('动态标注默认关闭。开启只允许此模式，按“开始跟踪”才会持续采集并增加处理开销。') }}</p></details>
        <v-alert v-if="draft.application?.state === 'unconfirmed'" type="warning" variant="tonal">{{ t('设置已保存；执行应用或停止仍待确认。') }} {{ draft.application.issue ? t(draft.application.issue) : '' }}</v-alert>
        <p v-else-if="draft.application?.state === 'offline'" class="computer-note">{{ t('设置已保存；目标离线，执行应用尚未确认。') }}</p>
        <p v-if="draft.application?.readbackIssue" class="computer-note">{{ t(draft.application.readbackIssue) }}</p>
        <div class="computer-save"><v-btn variant="tonal" :loading="draft.saving" :disabled="draft.saving || !defaultPaths.length" @click="restoreDefaults">{{ t('恢复默认设置') }}</v-btn><v-btn color="primary" :loading="draft.saving" :disabled="!draft.changes.size" @click="save(true)">{{ t(draft.readbackUnconfirmed ? '按最新版本重新应用编辑值' : '保存设置') }}</v-btn><span role="status">{{ draft.readbackUnconfirmed ? t('修改已提交，回读待确认') : draft.error ? `未保存：${draft.error}` : draft.saving ? t('保存中…') : draft.changes.size ? t('有未保存的修改') : t('设置已回读') }}</span><v-btn v-if="draft.conflict" variant="text" @click="save(true)">{{ t('按新版本保存保留的修改') }}</v-btn></div>
      </template>
      <section v-if="trackingRows.length" class="computer-tracking"><h3>{{ t('当前跟踪') }}</h3><div v-for="record in trackingRows" :key="String(record.trackingId)"><p class="computer-note">{{ record.state }}{{ t(' · 实际频率 ') }}{{ (record.metrics as any)?.rateHz ?? t('未测量') }}{{ t(' 次/秒 · 分析宽度 ') }}{{ (record.effective as any)?.maxAnalysisWidth ?? t('未测量') }}{{ t(' · 处理 ') }}{{ (record.metrics as any)?.processingMs ?? t('未测量') }} ms</p><p v-if="(record.effective as any)?.reason" class="computer-note">{{ (record.effective as any).reason }}</p><ul><li v-for="target in (record.targets as any[] || [])" :key="target.id">{{ target.description || target.id }} · {{ target.state }}<span v-if="target.similarity !== undefined">{{ t(' · 模板相似值 ') }}{{ target.similarity }}</span></li></ul></div></section>
      <figure v-if="screenshotUrl && active && image" class="computer-preview"><ComputerControlCanvas :image="image" :disabled="!enabled || features.annotation === false || !available('annotation')" :tracking-supported="target.capabilities?.includes('tracking') === true" :busy="!!busy" :dynamic-enabled="(settings.annotation as Record<string,unknown>)?.dynamicEnabled === true" :duration-ms="(settings.annotation as Record<string,unknown>)?.staticDurationMs" :backend="(settings.annotation as Record<string,unknown>)?.backend" :rate-hz="(settings.annotation as Record<string,unknown>)?.rateHz" @show="run" @track="run" /><div class="work-buttons"><v-btn :href="screenshotUrl" target="_blank" rel="noopener noreferrer" variant="text">{{ t('查看原图') }}</v-btn><v-btn :href="screenshotUrl" :download="`${target.name}-screen.png`" variant="text">{{ t('保存截图') }}</v-btn></div><figcaption>{{ image?.capturedAt || t('时间未提供') }}{{ t(' · 当前图像仅为观察；指针或预览不代表输入成功。') }}</figcaption></figure>
      <details v-if="active && (image || returnResult)" class="computer-information">
        <summary>{{ t('当前画面与操作结果') }}</summary>
        <dl>
          <template v-if="image">
          <dt>{{ t('画面范围') }}</dt><dd>{{ (image.source as any)?.displayId || (image.source as any)?.scope || (image.source as any)?.kind || t('来源未提供') }}</dd>
          <dt>{{ t('图像尺寸') }}</dt><dd>{{ image.width }} × {{ image.height }} {{ t('像素') }}</dd>
          <dt>{{ t('获取时间') }}</dt><dd>{{ image.capturedAt || t('时间未提供') }}</dd>
          <dt>{{ t('图像送达') }}</dt><dd>{{ image.deliveryState === 'provided' ? t('已提供给模型') : image.deliveryState === 'prepared' ? t('图像已准备，模型送达待确认') : t('截图已生成') }}</dd>
          </template>
          <template v-if="returnResult">
            <dt>{{ t('鼠标光标') }}</dt><dd>{{ returnDescription(returnResult.cursor) }}</dd>
            <dt>{{ t('前台焦点') }}</dt><dd>{{ returnDescription(returnResult.foreground) }}</dd>
            <dt>{{ t('按键释放') }}</dt><dd>{{ returnDescription(returnResult.keys) }}</dd>
          </template>
        </dl>
      </details>
      <details v-if="receipt || lastRequest || control || knownLayers.length" class="computer-diagnostics"><summary>{{ t('操作结果与详情') }}</summary><pre>{{ JSON.stringify({request:lastRequest,result:receipt,control,layers:knownLayers,tracking:knownTracking,application:draft?.application},null,2) }}</pre></details>
    </div>
    <RemoteTerminalDialog v-if="terminal" :instance-id="target.instanceId" :owner-device-id="target.ownerDeviceId" :name="target.name" :token="managerAccessToken()" @close="terminal=false" />
  </article>
</template>
<style scoped>
.computer-activity { padding: 10px 14px; margin: 8px 0; border-inline-start: 3px solid rgb(var(--v-theme-primary)); background: rgba(var(--v-theme-primary), .08); border-radius: 8px; font-weight: 600; }
.computer-information { border: 1px solid rgb(var(--v-theme-outline-variant)); border-radius: 10px; padding: 12px; }
.computer-information summary { cursor: pointer; font-weight: 600; }
.computer-information dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px 14px; margin: 12px 0 0; }
.computer-information dt { color: rgb(var(--v-theme-on-surface-variant)); }
.computer-information dd { margin: 0; overflow-wrap: anywhere; }

.computer-row{border-top:1px solid var(--rr-border);min-width:0;}.computer-summary{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:14px 0;}.computer-expand{display:flex;align-items:center;gap:8px;min-width:0;text-align:left;color:var(--rr-text);font:inherit;font-weight:600;background:none;border:0;padding:4px;cursor:pointer;flex:1;}.computer-expand span{overflow-wrap:anywhere;}.computer-expand:focus-visible{outline:2px solid var(--rr-accent-strong);outline-offset:3px;}.computer-tags,.work-buttons{display:flex;gap:8px;flex-wrap:wrap;}.computer-details{padding:0 12px 24px 32px;min-width:0;display:grid;gap:14px;}.computer-note{color:var(--rr-muted);font-size:.85rem;margin:4px 0;}.computer-work{padding:14px;background:var(--rr-surface);border-radius:8px;display:grid;gap:12px;}.current-work{color:var(--rr-accent-strong);font-size:.85rem;}.computer-feature{padding:12px 0;border-top:1px solid var(--rr-border);min-width:0;}.computer-feature>summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:10px;}.computer-feature h3{font-size:1rem;flex:1;}.computer-feature>summary .v-switch{flex:0 0 auto;}.computer-settings>summary,.computer-diagnostics>summary{cursor:pointer;font-weight:600;padding:10px 0;}.computer-save{display:flex;flex-wrap:wrap;align-items:center;gap:12px;font-size:.85rem;}.computer-preview{margin:0;min-width:0;}.computer-preview img{display:block;max-width:100%;height:auto;border-radius:8px;}.computer-preview figcaption{font-size:.8rem;color:var(--rr-muted);margin-top:6px;}.computer-diagnostics pre{max-height:320px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:.75rem;}@media(max-width:650px){.computer-details{padding-left:4px;padding-right:4px;}.computer-tags{width:100%;padding-left:32px;}.computer-summary{gap:8px;}}
</style>
