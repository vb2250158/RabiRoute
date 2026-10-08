<script setup lang="ts">
import {nextTick,onBeforeUnmount,onMounted,ref,watch} from "vue";
import {vacuumRemoteClient,type RemoteSession} from "../../vacuumRemoteClient";
import {userFacingError} from "../../userFacingError";
const props=defineProps<{active:boolean;resourceId:string}>();
const panel=ref<HTMLElement>(),session=ref<RemoteSession>(),error=ref(""),starting=ref(false),stopping=ref(false),exiting=ref(false),held=ref("");
const directions=[{key:"w",direction:"forward",label:"前进",icon:"mdi-arrow-up"},{key:"a",direction:"left",label:"左转",icon:"mdi-arrow-left"},{key:"d",direction:"right",label:"右转",icon:"mdi-arrow-right"}];
let epoch=0,running=false,stopTask:Promise<void>|undefined;
async function enter(){
 if(starting.value || session.value || !props.active)return;
 starting.value=true;error.value="";const current=++epoch;
 try{
  const caps=await vacuumRemoteClient.capabilities(props.resourceId);if(!caps.available)throw Error(caps.reason);
  const value=caps.activeSession || await vacuumRemoteClient.start(caps,"remote-start-"+crypto.randomUUID());
  if(current!==epoch || !props.active){await vacuumRemoteClient.exit(value.sessionId);return;}
  session.value=value;if(value.state!=="ready")error.value=value.error || "进入遥控未确认。";
  await nextTick();panel.value?.focus();
 }catch(e){error.value=userFacingError(e);}finally{starting.value=false;}
}
async function pump(){
 if(running || stopping.value || exiting.value)return;
 running=true;const current=epoch;
 try{while(held.value && session.value?.state==="ready" && props.active && current===epoch){
  const value=await vacuumRemoteClient.pulse(session.value,held.value,"remote-pulse-"+crypto.randomUUID());
  if(current!==epoch)break;session.value=value;if(value.state!=="ready"){held.value="";error.value=value.error || "遥控状态未确认。";}
 }}catch(e){held.value="";error.value=userFacingError(e);if(session.value)session.value={...session.value,state:"failed"};}
 finally{running=false;if(held.value && !stopping.value && !exiting.value && session.value?.state==="ready")void pump();}
}
function hold(direction:string){if(!props.active || starting.value || stopping.value || exiting.value || session.value?.state!=="ready")return;held.value=direction;void pump();}
async function stop(){
 held.value="";const id=session.value?.sessionId;if(!id || exiting.value)return;
 ++epoch;if(stopTask)return stopTask;
 stopping.value=true;
 stopTask=(async()=>{try{session.value=await vacuumRemoteClient.stop(id,"remote-stop-"+crypto.randomUUID());if(session.value.state!=="ready")error.value=session.value.error || "松键结果未确认。";}catch(e){error.value=userFacingError(e);if(session.value)session.value={...session.value,state:"failed"};}finally{stopping.value=false;stopTask=undefined;}})();return stopTask;
}
async function exit(){
 held.value="";++epoch;if(exiting.value)return;const id=session.value?.sessionId;if(!id)return;
 exiting.value=true;
 try{await stopTask;const value=await vacuumRemoteClient.exit(id);if(value.state==="stopped"){session.value=undefined;error.value="";}else{session.value=value;error.value=value.error || "退出结果尚未确认。";}}
 catch(e){error.value=userFacingError(e);}finally{exiting.value=false;}
}
function keydown(event:KeyboardEvent){
 if(!session.value || !panel.value?.contains(document.activeElement) || event.ctrlKey || event.metaKey || event.altKey || (event.target as HTMLElement)?.closest("input,textarea,select,[contenteditable=true]"))return;
 const key=event.key.toLowerCase();if(!["w","a","s","d"].includes(key))return;event.preventDefault();if(event.repeat)return;
 if(key==="s")void stop();else hold(directions.find(d=>d.key===key)!.direction);
}
function keyup(event:KeyboardEvent){const direction=directions.find(d=>d.key===event.key.toLowerCase());if(direction && held.value===direction.direction){event.preventDefault();void stop();}}
function blur(){if(starting.value)++epoch;else void stop();}
function hidden(){if(document.hidden)void exit();}
function focusout(event:FocusEvent){if(session.value && !panel.value?.contains(event.relatedTarget as Node | null))void stop();}
watch(()=>[props.active,props.resourceId],()=>{if(!props.active || session.value?.resourceId!==props.resourceId)void exit();});
onMounted(()=>{window.addEventListener("keydown",keydown);window.addEventListener("keyup",keyup);window.addEventListener("blur",blur);document.addEventListener("visibilitychange",hidden);});
onBeforeUnmount(()=>{void exit();window.removeEventListener("keydown",keydown);window.removeEventListener("keyup",keyup);window.removeEventListener("blur",blur);document.removeEventListener("visibilitychange",hidden);});
</script>
<template>
 <section ref="panel" tabindex="0" class="remote-panel" aria-label="扫地机手动控制" @focusout="focusout">
  <div class="remote-heading"><div><strong>手动控制</strong><p>{{session ? '控制面板获得焦点后，按住 W / A / D 移动，S 停止；松键即发送停止。' : '进入时暂停当前清扫，再切换遥控模式。网页和 Agent 使用同一接口。'}}</p></div><v-btn v-if="!session" variant="tonal" :loading="starting" :disabled="!active || starting" prepend-icon="mdi-gamepad-variant-outline" @click="enter">进入手动控制</v-btn><v-btn v-else variant="tonal" :loading="exiting" :disabled="exiting" @click="exit">退出手动控制</v-btn></div>
  <div v-if="session" class="remote-keys">
   <v-btn v-for="d in directions" :key="d.key" :prepend-icon="d.icon" :color="held===d.direction ? 'primary' : undefined" :disabled="session.state!=='ready' || stopping || exiting" :aria-label="d.label+' '+d.key.toUpperCase()" @pointerdown.prevent="hold(d.direction)" @pointerup="stop" @pointerleave="held===d.direction && stop()" @pointercancel="stop">{{d.key.toUpperCase()}} {{d.label}}</v-btn>
   <v-btn prepend-icon="mdi-stop" color="warning" :loading="stopping" :disabled="exiting" @click="stop">S 停止</v-btn>
  </div>
  <p v-if="session" class="remote-note">当前协议没有倒退指令。退出遥控可能触发设备自动回仓；不会自动恢复清扫。视频有延迟，请同时观察机器人。</p>
  <v-alert v-if="error" type="error" variant="tonal" density="compact">{{error}}</v-alert>
 </section>
</template>
<style scoped>
.remote-panel{margin-top:16px;border:1px solid rgba(var(--v-theme-on-surface),.15);border-radius:12px;padding:16px;line-height:1.5}.remote-panel:focus-visible{outline:2px solid rgb(var(--v-theme-primary));outline-offset:2px}.remote-heading{display:flex;align-items:center;justify-content:space-between;gap:16px}.remote-heading strong{font-size:16px}.remote-heading p,.remote-note{font-size:13px;color:rgba(var(--v-theme-on-surface),.75);margin:6px 0}.remote-keys{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}.remote-panel :deep(.v-btn){min-height:44px;text-transform:none;letter-spacing:normal}.remote-note{margin-bottom:10px}@media(max-width:600px){.remote-heading{align-items:flex-start;flex-direction:column}.remote-heading>.v-btn{width:100%}.remote-keys>.v-btn{flex:1 1 100px}}
</style>
