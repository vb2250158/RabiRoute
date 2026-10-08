<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { homeDeviceClient, deviceIcon, parameterDefaults, vacuumVideoSwitch, type DeviceDirectory, type DeviceResource, type DeviceActionChoice, type ActionResult } from "../../homeDeviceClient";
import VacuumVideoPreview from "./VacuumVideoPreview.vue";
import VacuumRemoteControl from "./VacuumRemoteControl.vue";
import { rankDevices, readDeviceUsage, recordDeviceOpen, type DeviceUsage } from "../../homeDeviceUsage";
import { userFacingError } from "../../userFacingError";
const directory = ref<DeviceDirectory>();
const loading = ref(false), busy = ref(false), error = ref(""), search = ref(""), detailOpen = ref(false), detailTab = ref("abilities");
const selectedId = ref(""), resourceId = ref(""), actionId = ref(""), parameters = ref("{}");
const inspected = ref<DeviceResource>();
const capabilities = ref<Array<{ capability: string; argumentsSchema?: Record<string, unknown> }>>([]);
const results = ref<Record<string, ActionResult>>({});
const usageAtRefresh = ref<DeviceUsage[]>([]);
const result = computed(()=>results.value[resourceId.value]);
const lastKey = computed(()=>result.value?.idempotencyKey || "");
const cards = computed(() => rankDevices(directory.value?.devices || [], usageAtRefresh.value).filter(d => [d.displayName,d.areaName,d.model].join(" ").toLowerCase().includes(search.value.toLowerCase())));
const selected = computed(() => selectedId.value === "unassigned" ? { deviceId: "unassigned", displayName: "场景与辅助实体", model: "", manufacturer: "", areaName: "", resources: directory.value?.unassignedResources || [] } : directory.value?.devices.find(d => d.deviceId === selectedId.value));
const vacuum = computed(() => selected.value?.resources.find(item => item.kind === "vacuum"));
const videoSwitch = computed(() => selectedId.value === "unassigned" ? undefined : vacuumVideoSwitch(directory.value?.devices.find(item => item.deviceId === selectedId.value)));
const label: Record<string, string> = { "home.vacuum.start@1": "开始清扫", "home.vacuum.return_home@1": "回基站", "home.speaker.speak@1": "文字播报", "home.light.turn_on@1": "开灯", "home.light.turn_off@1": "关灯", "home.switch.turn_on@1": "打开", "home.switch.turn_off@1": "关闭", "home.fan.turn_on@1": "开启风扇", "home.fan.turn_off@1": "关闭风扇", "home.cover.open@1": "打开窗帘", "home.cover.close@1": "关闭窗帘", "home.cover.stop@1": "停止窗帘", "home.climate.turn_off@1": "关闭空调", "home.climate.set_temperature@1": "设置温度" };
const choices = computed<DeviceActionChoice[]>(() => !inspected.value ? [] : [
 ...capabilities.value.filter(item => item.argumentsSchema && inspected.value!.capabilities.includes(item.capability)).map(item => ({ id: item.capability, title: label[item.capability] || item.capability, capability: item.capability, argumentsSchema: item.argumentsSchema! })),
 ...(inspected.value.actions || []).map(action => ({ id: "entity:" + action.action, title: action.name || action.action, capability: action.capability, action, argumentsSchema: action.argumentsSchema as Record<string, unknown> }))
]);
const choice = computed(() => choices.value.find(item => item.id === actionId.value));
const uncertain = computed(() => result.value?.state === "uncertain" || result.value?.state === "in_progress");
const cloudDeviceId = computed(() => /^[^.]+\.xiaomi_[a-z]{2}_(\d{1,32})_/.exec(vacuum.value?.entityId || "")?.[1]);
const mapUrl = computed(() => {
 const match = cloudDeviceId.value;
 const query = new URLSearchParams({ view: "embedded", ...(match ? { deviceId: match } : {}) });
 return "/api/agent/xiaomi-home/vacuum-cloud/connect?" + query;
});
async function load() { loading.value = true; error.value = ""; try { const [data, caps] = await Promise.all([homeDeviceClient.directory(), homeDeviceClient.capabilities()]); try { usageAtRefresh.value = readDeviceUsage(localStorage); } catch { usageAtRefresh.value = []; } directory.value = data; capabilities.value = caps.actions; } catch(cause) { error.value = userFacingError(cause); } finally { loading.value = false; } }
async function inspect() { if (!resourceId.value) return; const id=resourceId.value; loading.value=true; error.value=""; try { const data=await homeDeviceClient.inspect(id); if(id===resourceId.value) inspected.value=data; } catch(cause) {error.value=userFacingError(cause);} finally{loading.value=false;} }
function open(id: string) { if(directory.value?.devices.some(device=>device.deviceId===id)) { try { recordDeviceOpen(localStorage,id); } catch {} } selectedId.value=id; detailTab.value="abilities"; inspected.value=undefined; actionId.value=""; resourceId.value=selected.value?.resources.find(item=>["vacuum","media_player","climate","fan","light","switch"].includes(item.kind))?.resourceId || selected.value?.resources[0]?.resourceId || ""; detailOpen.value=true; }
watch(resourceId,()=>void inspect());
watch(choice, next=>{ parameters.value=JSON.stringify(parameterDefaults(next?.argumentsSchema || {}),null,2); });
async function testAction(dryRun: boolean) { if(busy.value||!choice.value||uncertain.value)return; let args: Record<string,unknown>; try {args=JSON.parse(parameters.value);if(!args||Array.isArray(args)||typeof args!=="object")throw Error("参数必须是 JSON 对象。");}catch(cause){error.value=userFacingError(cause);return;}
 const currentChoice=choice.value,id=resourceId.value;busy.value=true;error.value="";const key="device-test-"+crypto.randomUUID();
 results.value[id]={idempotencyKey:key,state:"in_progress"};
 try {localStorage.setItem(historyKey,JSON.stringify(results.value));results.value[id]=await homeDeviceClient.execute(id,currentChoice,args,dryRun,key);await inspect();if(vacuum.value&&currentChoice.capability==="home.vacuum.start@1"&&!dryRun)detailTab.value="map";}
 catch(cause){results.value[id]={idempotencyKey:key,state:"failed",error:userFacingError(cause)};error.value=userFacingError(cause);}finally{busy.value=false;}
}
async function queryReceipt(){if(!lastKey.value||busy.value)return;busy.value=true;try{const id=resourceId.value,key=lastKey.value;results.value[id]=await homeDeviceClient.receipt(key);}catch(cause){error.value=userFacingError(cause);}finally{busy.value=false;}}
const resultLabel = computed(()=>result.value?.state==='uncertain'?'结果未知，只查询原回执':result.value?.state==='in_progress'?'动作处理中':({planned:'预演通过，未执行',accepted:'设备服务已受理',succeeded:'状态已读回',failed:'动作失败',uncertain:'结果未知'} as Record<string,string>)[String(result.value?.receipt?.status)] || result.value?.state);
const historyKey = "rabi-home-device-test-receipt";
watch(results, value => { try{localStorage.setItem(historyKey,JSON.stringify(value));}catch{} }, {deep:true});
onMounted(()=>{
 try{const saved=localStorage.getItem(historyKey);if(saved){const value=JSON.parse(saved);if(value&&typeof value==='object'&&!Array.isArray(value)){
  const restored: Record<string,ActionResult>={};
  for(const [id,raw] of Object.entries(value).slice(-200)){if(!id.startsWith('home:ha:')||!raw||typeof raw!=='object')continue;const record=raw as Record<string,unknown>;
   if(typeof record.idempotencyKey==='string'&&typeof record.state==='string')restored[id]={idempotencyKey:record.idempotencyKey,state:record.state,...(record.receipt&&typeof record.receipt==='object'&&!Array.isArray(record.receipt)?{receipt:record.receipt as Record<string,unknown>}:{})};}
  results.value=restored;
 }}}catch{}void load();
});
</script>

<template>
 <div class="device-directory">
  <div class="device-toolbar"><div><h3>已接入设备</h3><p>Rabi 通过当前连接提供设备查询和控制。</p></div><v-btn variant="tonal" prepend-icon="mdi-refresh" :loading="loading" @click="load">刷新设备</v-btn></div>
  <v-alert v-if="error" type="error" variant="tonal" class="my-3">{{error}}</v-alert>
  <v-progress-linear v-if="loading" indeterminate color="secondary" />
  <template v-if="directory"><p>{{directory.devices.length}} 台已登记设备 · {{directory.devices.reduce((sum,d)=>sum+d.resources.length,0)}} 个设备实体 · {{directory.unassignedResources.length}} 个场景与辅助实体</p>
   <v-text-field v-model="search" label="搜索设备、房间或型号" prepend-inner-icon="mdi-magnify" clearable @click:clear="search=''" />
   <div class="device-cards"><button v-for="device in cards" :key="device.deviceId" class="device-card" @click="open(device.deviceId)"><v-icon :icon="deviceIcon(device.resources)" size="30" /><span class="device-card-title">{{device.displayName}}</span><span>{{device.areaName || '未分配房间'}}</span><small>{{device.model}}</small><span>{{device.resources.filter(r=>r.state!=='unavailable').length}} / {{device.resources.length}} 项可查询</span><span class="device-card-link">查看能力与测试 <v-icon size="16" icon="mdi-chevron-right" /></span></button></div>
   <v-btn v-if="directory.unassignedResources.length" variant="text" class="mt-3" @click="open('unassigned')">查看场景与辅助实体</v-btn>
  </template>
  <v-dialog v-model="detailOpen" max-width="1160" scrollable><v-card v-if="selected"><v-card-title class="device-toolbar device-detail-heading"><span><v-icon :icon="deviceIcon(selected.resources)" class="mr-2" />{{selected.displayName}}</span><v-btn icon="mdi-close" variant="text" aria-label="关闭设备详情" @click="detailOpen=false" /></v-card-title>
   <v-tabs v-model="detailTab" color="primary"><v-tab value="abilities">能力与测试</v-tab><v-tab v-if="vacuum" value="map">地图与位置</v-tab><v-tab value="info">设备信息</v-tab></v-tabs>
   <v-card-text>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-3">{{error}}</v-alert>
    <div v-if="detailTab==='abilities'">
     <v-select v-model="resourceId" :items="selected.resources.map(r=>({title:r.displayName+' · '+r.state,value:r.resourceId}))" label="查询项或控制项" :disabled="busy" />
     <v-progress-linear v-if="loading" indeterminate />
     <template v-if="inspected"><div class="resource-state"><v-chip size="small" :color="inspected.state==='unavailable'?'warning':'success'">{{inspected.state}}</v-chip><span>{{inspected.kind}} · {{new Date(inspected.observedAt).toLocaleString()}}</span><v-btn variant="text" size="small" @click="inspect">查询最新状态</v-btn></div>
      <div class="capability-tags"><v-chip v-for="capability in inspected.capabilities" :key="capability" size="small" variant="tonal">{{capability}}</v-chip></div>
      <v-select v-model="actionId" :items="choices.map(c=>({title:c.title,value:c.id}))" label="选择要测试的动作" :disabled="busy||!choices.length" class="mt-4" />
      <p v-if="!choices.length">此项提供查询，上游尚未公布可执行动作。</p>
      <template v-if="choice"><p>{{choice.action?.description}}</p><v-textarea v-model="parameters" label="动作参数（JSON）" rows="4" auto-grow :disabled="busy" /><details><summary>查看 Agent 参数规范</summary><pre>{{JSON.stringify(choice.argumentsSchema,null,2)}}</pre></details>
       <div class="test-buttons"><v-btn variant="tonal" :disabled="busy||uncertain" @click="testAction(true)">预演参数</v-btn><v-btn color="primary" :disabled="busy||uncertain||inspected.state==='unavailable'" @click="testAction(false)">执行测试</v-btn></div>
      </template>
      <details class="mt-3"><summary>状态属性</summary><pre>{{JSON.stringify(inspected.attributes,null,2)}}</pre></details>
     </template>
     <v-alert v-if="result" :type="uncertain?'warning':result.receipt?.status==='failed'||result.state==='failed'?'error':'info'" variant="tonal" class="mt-4"><strong>{{resultLabel}}</strong><p>服务受理不代表物理动作已完成。</p><v-btn size="small" variant="text" :disabled="busy" @click="queryReceipt">查询原回执</v-btn><details><summary>回执详情</summary><pre>{{JSON.stringify(result,null,2)}}</pre></details></v-alert>
    </div>
    <div v-else-if="detailTab==='map' && vacuum"><p>自动刷新地图和轨迹位置，定位时间尚未验证；点击地图选择目标并预览路径，预览不会移动机器人。</p><div class="vacuum-map-layout"><iframe v-if="detailOpen" :src="mapUrl" title="扫地机地图与坐标" class="vacuum-map-frame" /><VacuumVideoPreview v-if="detailOpen" class="vacuum-video-overlay" :active="detailOpen && detailTab==='map'" :resource-id="videoSwitch?.resourceId" :device-id="cloudDeviceId" /></div><VacuumRemoteControl v-if="detailOpen" :active="detailOpen" :resource-id="vacuum.resourceId" /><v-btn disabled variant="tonal" class="mt-3" prepend-icon="mdi-map-marker-path">移动机器人到目标点</v-btn><v-alert type="info" variant="tonal" class="mt-3">到点移动尚未接通，当前点击地图可预览路径，不发送移动动作。已接通动作可在“能力与测试”中执行。</v-alert></div>
    <dl v-else><dt>设备 ID</dt><dd>{{selected.deviceId}}</dd><dt>型号</dt><dd>{{selected.model || '未提供'}}</dd><dt>厂商</dt><dd>{{selected.manufacturer || '未提供'}}</dd><dt>房间</dt><dd>{{selected.areaName || '未分配'}}</dd><dt>实体数</dt><dd>{{selected.resources.length}}</dd></dl>
   </v-card-text>
  </v-card></v-dialog>
 </div>
</template>
<style scoped>
.device-toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px}.device-toolbar h3{font-size:19px;margin:0}.device-toolbar p{margin:6px 0;color:rgb(var(--v-theme-on-surface-variant))}.device-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(215px,1fr));gap:14px}.device-card{display:flex;flex-direction:column;gap:7px;align-items:flex-start;padding:20px;text-align:left;border:1px solid rgba(var(--v-theme-on-surface),.14);border-radius:14px;background:rgb(var(--v-theme-surface));color:rgb(var(--v-theme-on-surface));transition:border-color .15s,box-shadow .15s}.device-card:hover,.device-card:focus-visible{border-color:rgb(var(--v-theme-primary));box-shadow:0 3px 12px rgba(0,0,0,.08)}.device-card-title{font-size:16px;font-weight:700}.device-card small{opacity:.7;overflow-wrap:anywhere}.device-card-link{color:rgb(var(--v-theme-primary));margin-top:8px}.capability-tags,.test-buttons,.resource-state{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.capability-tags{margin-top:12px}.test-buttons{margin:18px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:12px;background:rgba(var(--v-theme-on-surface),.04);border-radius:8px;font-size:12px}.vacuum-map-frame{border:0;width:100%;height:clamp(300px,calc(100dvh - 350px),650px);border-radius:12px}dl{display:grid;grid-template-columns:100px 1fr;gap:12px}dd{overflow-wrap:anywhere;margin:0}
</style>
<style scoped>
.vacuum-map-layout{position:relative;line-height:0;container-type:inline-size}.vacuum-video-overlay{position:absolute;right:16px;bottom:72px;line-height:normal;z-index:1;max-width:calc(100% - 32px);max-height:calc(100% - 88px);overflow-y:auto}
@container(max-width:840px){.vacuum-video-overlay.is-playing{width:220px}.vacuum-video-overlay:not(.is-playing){position:relative;margin:12px 0 0 auto;right:auto;bottom:auto;max-height:none}}
@container(max-width:420px){.vacuum-video-overlay.is-playing{position:relative;width:220px;right:auto;bottom:auto;max-height:none;margin:8px 0 0 auto}.vacuum-video-overlay{max-width:100%}}
@media(max-width:600px){.device-detail-heading{gap:8px;align-items:flex-start}.device-detail-heading>span{font-size:18px;white-space:normal;overflow-wrap:anywhere}.device-detail-heading>.v-btn{flex-shrink:0}.vacuum-map-frame{height:clamp(320px,55dvh,520px);min-height:0}.device-cards{grid-template-columns:repeat(auto-fill,minmax(min(215px,100%),1fr))}}
</style>
