<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { homeDeviceClient, vacuumVideoClient, type VacuumVideoSession, type VacuumVideoNetwork, type DeviceResource } from "../../homeDeviceClient";
import { userFacingError } from "../../userFacingError";
import { vacuumVideoPresentation } from "../../vacuumVideoPresentation";
import { startVacuumLivePlayback } from "../../vacuumLivePlayback";
const props = defineProps<{ active: boolean; resourceId?: string; deviceId?: string }>();
const controlsVisible = ref(false), loading = ref(false), error = ref("");
const resource = ref<DeviceResource>(), checkedAt = ref("");
const session = ref<VacuumVideoSession>(), videoBusy = ref(false), rendered = ref(false);
const videoElement = ref<HTMLVideoElement>(), playbackGap = ref<number>();
let livePlayback: ReturnType<typeof startVacuumLivePlayback> | undefined;
const videoPassword = ref(""), rememberPassword = ref(true), passwordSaved = ref(false);
const starting = ref(false), stopping = ref(false), editingPassword = ref(false), revealPassword = ref(false);
const passwordChecked = ref(false);
const view = computed(() => vacuumVideoPresentation({ session: session.value, starting: starting.value, stopping: stopping.value, passwordSaved: passwordSaved.value, editingPassword: editingPassword.value, rendered: rendered.value }));
const network = ref<VacuumVideoNetwork>();
const connectionFailed = computed(() => session.value?.state === "failed" && session.value.connectionMode !== "relay" && ["camera_connection_timeout", "camera_lan_unreachable"].includes(session.value.error || ""));
const sessionError = computed(() => ({ xiaomi_vacuum_cloud_video_password_rejected: "视频密码不正确，请重新输入。", xiaomi_vacuum_cloud_video_password_unconfirmed: "设备未确认视频密码，请在米家中核对。", camera_connection_timeout: session.value?.connectionMode === "relay" ? "小米中继已建立，等待扫地机画面超时。" : "局域网视频连接超时。请确认电脑和扫地机可互相访问，并退出米家的视频页。", camera_lan_unreachable: "无法连接扫地机的局域网地址，请检查网络连接。", camera_auth_rejected: "视频传输身份校验失败，请重新连接米家云后再试。", camera_relay_discovery_timeout: "小米视频中继没有返回连接信息。", camera_relay_registration_timeout: "小米视频中继未确认连接登记。", camera_relay_allocation_timeout: "小米视频中继未分配视频连接。", camera_relay_device_join_timeout: "中继等待扫地机加入超时，请退出米家视频页后再试。", camera_relay_parameters_invalid: "小米视频中继参数不兼容。", camera_relay_connection_failed: "小米视频中继连接失败。" } as Record<string, string>)[session.value?.error || ""] || "摄像头没有返回可播放的画面。");
let epoch = 0;
const streaming = computed(() => props.active && !stopping.value && session.value?.state === "streaming" && session.value.sessionId);
const showPlaybackControls = computed(() => controlsVisible.value || !rendered.value || Boolean(error.value));
function togglePlaybackControls() { controlsVisible.value = !controlsVisible.value; }
let stopRequest: Promise<void> | undefined;
let controller: AbortController | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
const switchLabel = computed(() => !resource.value ? "摄像头状态未确认" : ({ on: "摄像头已开启", off: "摄像头已关闭", unavailable: "摄像头离线", unknown: "摄像头状态未知" } as Record<string, string>)[resource.value.state] || "摄像头状态未知");
function cancel() { clearTimeout(timer); controller?.abort(); controller = undefined; loading.value = false; }
async function refresh() {
 if (!props.active || document.hidden || !props.resourceId || controller) return;
 clearTimeout(timer);
 const id = props.resourceId, current = new AbortController(); controller = current; loading.value = true; error.value = "";
 try {
  const value = await homeDeviceClient.inspect(id, current.signal);
  if (controller === current && props.resourceId === id) { resource.value = value; checkedAt.value = new Date().toLocaleTimeString(); }
  const sessionId = session.value?.sessionId, queriedEpoch = epoch;
  if (sessionId && controller === current) {
   const value = await vacuumVideoClient.status(sessionId, current.signal);
   if (controller === current && epoch === queriedEpoch && session.value?.sessionId === sessionId) session.value = value;
  }
 } catch (cause) {
  if (!current.signal.aborted && controller === current) { resource.value = undefined; error.value = userFacingError(cause); }
 } finally {
  if (controller === current) { controller = undefined; loading.value = false; if (props.active && !document.hidden) timer = setTimeout(() => void refresh(), 5000); }
 }
}
async function refreshPasswordStatus() {
 const id = props.deviceId;
 if (!id || !props.active) return;
 try { const value = await vacuumVideoClient.passwordStatus(id); if (props.deviceId === id) passwordSaved.value = value.saved; }
 catch(cause) { error.value = userFacingError(cause); }
 finally { if (props.deviceId === id) passwordChecked.value = true; }
}
async function refreshNetwork(deviceId: string, currentEpoch: number) {
 try { const value = await vacuumVideoClient.network(deviceId); if (epoch === currentEpoch && props.deviceId === deviceId && props.active) network.value = value; }
 catch { /* Optional diagnosis must not prevent a video connection or mask its receipt. */ }
}
async function forgetPassword() {
 if (!props.deviceId || videoBusy.value || !view.value.passwordManagement) return;
 videoBusy.value = true;
 try { await vacuumVideoClient.forgetPassword(props.deviceId, "video-password-forget-" + crypto.randomUUID()); await refreshPasswordStatus(); }
 catch(cause) { error.value = userFacingError(cause); } finally { videoBusy.value = false; }
}
async function stopVideo() {
 livePlayback?.stop(); livePlayback = undefined; playbackGap.value = undefined;
 if (stopRequest) return stopRequest;
 const id = session.value?.sessionId, stoppedEpoch = ++epoch;
 rendered.value = false; controlsVisible.value = false; videoPassword.value = ""; revealPassword.value = false; editingPassword.value = false;
 if (!id) return;
 stopping.value = true;
 stopRequest = (async () => {
  try {
   const value = await vacuumVideoClient.stop(id);
   if (epoch !== stoppedEpoch || session.value?.sessionId !== id) return;
   if (value.state === "stopped" || value.state === "failed") { session.value = undefined; error.value = ""; }
   else { session.value = value; error.value = "退出尚未确认，请再次查询或退出视频。"; }
  } catch (cause) { if (epoch === stoppedEpoch) error.value = userFacingError(cause); }
  finally { stopping.value = false; stopRequest = undefined; }
 })();
 return stopRequest;
}
async function startVideo() {
 if (videoBusy.value || !passwordChecked.value || !props.deviceId || !view.value.passwordManagement) return;
 if (videoPassword.value && !/^\d{4}$/.test(videoPassword.value)) { error.value = "请输入四位视频密码。"; return; }
 videoBusy.value = true; starting.value = true; error.value = ""; rendered.value = false; controlsVisible.value = false; editingPassword.value = false; revealPassword.value = false;
 const startedEpoch = ++epoch, deviceId = props.deviceId;
 network.value = undefined; void refreshNetwork(deviceId, startedEpoch);
 let password: string | undefined = videoPassword.value || undefined; videoPassword.value = "";
 try {
  // Reconstruct presentation from the provider's existing session; never create a second camera connection.
  const existing = await vacuumVideoClient.current(deviceId);
  if (epoch !== startedEpoch || !props.active || document.hidden || props.deviceId !== deviceId) return;
  const pending = existing ? Promise.resolve(existing) : vacuumVideoClient.start(deviceId, "video-preview-" + crypto.randomUUID(), password, rememberPassword.value); password = undefined;
  const value = await pending;
  if (epoch !== startedEpoch || !props.active || document.hidden || props.deviceId !== deviceId) { if (!existing && value.sessionId) await vacuumVideoClient.stop(value.sessionId); return; }
  session.value = value; await refreshPasswordStatus(); resume();
 } catch (cause) { error.value = userFacingError(cause); } finally { password = undefined; starting.value = false; videoBusy.value = false; }
}
async function retryVideo() {
 if (videoBusy.value || stopping.value || session.value?.state !== "failed") return;
 await stopVideo();
 if (!session.value && props.active && !document.hidden) await startVideo();
}
function resume() { cancel(); if (document.hidden || !props.active) { void stopVideo(); return; } void refresh(); }
watch(() => [videoElement.value, streaming.value] as const, ([element, id]) => {
 livePlayback?.stop(); livePlayback = undefined; playbackGap.value = undefined;
 if (!element || !id) return;
 const playback = startVacuumLivePlayback(element, vacuumVideoClient.streamUrl(String(id)), gap => {if (livePlayback === playback) playbackGap.value = gap;});
 livePlayback = playback;
 void playback.finished.catch(cause => {if (livePlayback === playback) {rendered.value = false; error.value = userFacingError(cause);}});
}, {flush: "post"});
watch(() => [props.active, props.resourceId, props.deviceId], async () => { const id = props.deviceId; cancel(); await stopVideo(); if (props.deviceId !== id) return; session.value = undefined; resource.value = undefined; checkedAt.value = ""; error.value = ""; network.value = undefined; passwordSaved.value = false; passwordChecked.value = false; void refreshPasswordStatus(); resume(); });
onMounted(() => { document.addEventListener("visibilitychange", resume); void refreshPasswordStatus(); resume(); });
onBeforeUnmount(() => { livePlayback?.stop(); livePlayback = undefined; cancel(); void stopVideo(); document.removeEventListener("visibilitychange", resume); });
</script>

<template>
 <aside class="vacuum-video-preview" :class="{ 'is-playing': streaming }" aria-label="扫地机实时视频预览" @keydown.esc.stop="controlsVisible=false">
   <div v-if="!view.passwordManagement" class="video-stage" :aria-busy="starting || stopping || session?.state==='connecting'">
    <video v-if="streaming" ref="videoElement" :key="String(streaming)" muted playsinline aria-label="扫地机实时画面" @playing="rendered=true" @waiting="rendered=false" @error="rendered=false; error='画面播放中断，请退出后重新连接。'" />
    <template v-if="streaming">
     <button class="video-surface-toggle" type="button" :aria-label="controlsVisible ? '隐藏视频操作' : '显示视频操作'" :aria-expanded="showPlaybackControls" @click="togglePlaybackControls"><span class="focus-hint">按 Enter 显示或隐藏操作</span></button>
     <div v-if="showPlaybackControls" class="playback-overlay">
      <div class="playback-top"><span class="playback-status"><i :class="{ live: rendered }" />{{view.label}}</span><v-btn icon="mdi-chevron-down" variant="text" aria-label="隐藏视频操作" @click="controlsVisible=false" /></div>
      <div class="playback-bottom">
       <p v-if="playbackGap!==undefined" class="playback-caption" :title="'仅表示播放位置落后已收到视频的时间，不包含摄像头及网络延迟。'">播放缓冲 {{playbackGap.toFixed(2)}} 秒</p>
       <p v-if="error" class="playback-error" role="alert">{{error}}</p>
       <div class="playback-actions"><span class="playback-caption">{{session?.connectionMode === 'relay' ? '中继' : '局域网'}} · 仅画面</span><v-btn v-if="resourceId" icon="mdi-refresh" variant="text" aria-label="刷新摄像头状态" :title="`${switchLabel} · ${checkedAt}`" :loading="loading" @click="refresh" /><v-btn variant="text" prepend-icon="mdi-stop-circle-outline" @click="stopVideo">退出视频</v-btn></div>
      </div>
     </div>
    </template>
    <div v-else class="video-placeholder" role="status" aria-live="polite">
     <v-progress-circular v-if="['starting','connecting','stopping'].includes(view.phase)" indeterminate size="28" width="2" color="primary" />
     <v-icon v-else :icon="view.phase==='failed' ? 'mdi-video-off-outline' : 'mdi-video-outline'" size="32" />
     <strong>{{view.label}}</strong><span>{{view.phase==='idle' ? '开启后查看扫地机视角' : view.phase==='failed' ? '点击重新连接，或退出后管理密码' : '关闭地图会停止视频'}}</span>
    </div>
   </div>
   <div v-if="!streaming" class="video-body">
    <div v-if="view.passwordManagement" class="video-title"><v-icon icon="mdi-video-outline" size="18" /><span>实时视频</span></div>
    <p v-if="view.passwordManagement && !passwordChecked" class="video-hint" role="status">正在读取连接设置…</p>
    <template v-if="view.passwordManagement && passwordChecked">
     <div v-if="passwordSaved" class="saved-password"><span><v-icon icon="mdi-lock-check-outline" size="18" /> 密码已保存</span><v-btn variant="text" size="small" :aria-expanded="editingPassword" :disabled="videoBusy" @click="editingPassword=!editingPassword; videoPassword=''; revealPassword=false">{{editingPassword ? '收起' : '管理密码'}}</v-btn></div>
     <form v-if="view.passwordEntry" class="video-password" @submit.prevent="startVideo">
      <v-text-field v-model="videoPassword" :type="revealPassword ? 'text' : 'password'" :label="passwordSaved ? '更换视频密码' : '视频密码'" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="米家四位视频密码" density="compact" variant="outlined" hide-details :disabled="videoBusy" :aria-label="passwordSaved ? '更换视频密码' : '视频密码'"><template #append-inner><v-btn :icon="revealPassword ? 'mdi-eye-off-outline' : 'mdi-eye-outline'" size="small" variant="text" :aria-label="revealPassword ? '隐藏视频密码' : '显示视频密码'" :disabled="videoBusy" @click="revealPassword=!revealPassword" /></template></v-text-field>
      <v-checkbox v-model="rememberPassword" label="记住密码（本机）" density="compact" hide-details :disabled="videoBusy" />
      <p class="video-hint">{{rememberPassword ? '验证后加密保存，下次直接连接。' : '本次输入不保存。'}}</p>
      <v-btn v-if="passwordSaved" class="forget-password" color="error" variant="text" size="small" :disabled="videoBusy" @click="forgetPassword">删除本机保存的密码</v-btn>
     </form>
    </template>
    <p v-if="session?.state==='failed' && !stopping" class="video-error" role="alert">{{sessionError}}</p>
    <p v-if="error" class="video-error" role="alert">{{error}}</p>
    <div class="video-controls">
     <v-btn v-if="session?.state==='failed' && !starting && !stopping" block color="primary" variant="flat" prepend-icon="mdi-refresh" :disabled="videoBusy" @click="retryVideo">重新连接</v-btn>
     <v-btn v-if="view.sessionOpen || starting || stopping" block variant="tonal" :loading="stopping" :disabled="starting" prepend-icon="mdi-stop-circle-outline" @click="stopVideo">{{stopping ? '正在退出' : '退出视频'}}</v-btn>
     <v-btn v-else block color="primary" variant="flat" :disabled="!deviceId || !passwordChecked || videoBusy" :loading="videoBusy" prepend-icon="mdi-play-outline" @click="startVideo">开启视频</v-btn>
    </div>
    <p class="video-hint">持续连接至退出 · 不收音、不录制</p>
    <details v-if="connectionFailed && network && !network.onLinkInterfacePresent" class="network-help"><summary>查看网络连接建议</summary><p>扫地机地址：{{network.localAddress}}。请确认两网段可互通；使用两级路由器时，可将电脑接到扫地机所在路由器的 LAN 口或 Wi-Fi 后再试。</p></details>
   </div>
 </aside>
</template>

<style scoped>
.vacuum-video-preview{width:280px;max-width:100%;border:1px solid rgba(var(--v-theme-on-surface),.16);border-radius:12px;background:rgb(var(--v-theme-surface));color:rgb(var(--v-theme-on-surface));box-shadow:0 6px 24px rgba(0,0,0,.22);overflow:hidden;line-height:1.5;container-type:inline-size}
.video-title{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600}
.video-stage{position:relative;aspect-ratio:16/9;background:rgba(var(--v-theme-on-surface),.045)}
.video-stage video{display:block;width:100%;height:100%;object-fit:contain;background:#000}
.video-surface-toggle{position:absolute;inset:0;width:100%;height:100%;border:0;background:transparent;cursor:pointer;z-index:1}.video-surface-toggle:focus-visible{outline:2px solid rgb(var(--v-theme-primary));outline-offset:-3px}.focus-hint{display:none;position:absolute;inset:auto 8px 8px;padding:4px;border-radius:4px;background:#000b;color:#fff;font-size:11px}.video-surface-toggle:focus-visible .focus-hint{display:block}
.playback-overlay{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:space-between;color:#fff;pointer-events:none;z-index:2;background:linear-gradient(#0009,transparent 40%,transparent 55%,#000b)}.playback-overlay :deep(.v-btn){pointer-events:auto;color:#fff;min-height:44px;letter-spacing:normal;text-transform:none}.playback-top,.playback-actions{display:flex;align-items:center;justify-content:space-between;gap:4px;padding:0 6px}.playback-status{display:flex;align-items:center;gap:6px;font-size:12px;padding-left:4px}.playback-status i{width:6px;height:6px;border-radius:50%;background:#d1d5db}.playback-status i.live{background:#49dd8a}.playback-caption{font-size:11px;white-space:nowrap;padding-left:4px}.playback-error{font-size:12px;margin:0;padding:4px 10px;color:#fff;overflow-wrap:anywhere;max-height:48px;overflow-y:auto;pointer-events:auto}
.video-placeholder{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:16px;text-align:center;color:rgba(var(--v-theme-on-surface),.8)}.video-placeholder strong{font-size:14px;color:rgb(var(--v-theme-on-surface))}.video-placeholder span{font-size:12px}
.video-body{padding:12px 16px;display:flex;flex-direction:column;gap:8px}.saved-password{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px}.saved-password>span{display:flex;align-items:center;gap:6px;min-width:0}.saved-password :deep(.v-btn){flex-shrink:0}
.video-password{padding:8px 0 4px}.video-password :deep(input){font-size:16px}.video-password :deep(.v-label){font-size:14px}.video-password :deep(.v-field__append-inner){padding-top:0;align-items:center}.video-password :deep(.v-selection-control){min-height:44px}.video-controls :deep(.v-btn){min-height:44px;text-transform:none;letter-spacing:normal}.video-hint{font-size:12px;color:rgba(var(--v-theme-on-surface),.8);margin:0;overflow-wrap:anywhere}.forget-password{margin-top:8px;max-width:100%}
.video-error{font-size:13px;margin:0;color:rgb(var(--v-theme-error));overflow-wrap:anywhere}.network-help{font-size:12px;overflow-wrap:anywhere}.network-help summary{cursor:pointer;padding:8px 0}.network-help p{margin:4px 0}
.vacuum-video-preview :deep(.v-btn--icon){width:44px;height:44px}.saved-password :deep(.v-btn),.forget-password{min-height:44px}.vacuum-video-preview :deep(.v-btn:focus-visible),.network-help summary:focus-visible{outline:2px solid rgb(var(--v-theme-primary));outline-offset:2px}
@container(max-width:260px){.saved-password{flex-wrap:wrap}.video-body{padding:12px}.playback-caption{display:none}.playback-actions{justify-content:flex-end}.playback-top{gap:0}.playback-status{font-size:11px}}
@media(prefers-reduced-motion:reduce){.vacuum-video-preview :deep(.v-progress-circular__overlay){animation:none}}
</style>
