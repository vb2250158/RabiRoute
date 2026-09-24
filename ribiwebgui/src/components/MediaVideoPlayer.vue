<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps<{ src: string }>();
const player = ref<HTMLElement>();
const video = ref<HTMLVideoElement>();
const loop = ref(true);
const playing = ref(false);
const muted = ref(false);
const volume = ref(1);
const time = ref(0);
const duration = ref(0);
const fullscreen = ref(false);
const failure = ref("");
const canSeek = computed(() => Number.isFinite(duration.value) && duration.value > 0);
function clock(value: number) {
  const seconds = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
function sync() {
  if (!video.value) return;
  playing.value = !video.value.paused && !video.value.ended;
  muted.value = video.value.muted || video.value.volume === 0;
  volume.value = video.value.volume;
  time.value = video.value.currentTime;
  duration.value = video.value.duration;
}
async function togglePlayback() {
  if (!video.value) return;
  failure.value = "";
  try { if (video.value.paused) await video.value.play(); else video.value.pause(); }
  catch { failure.value = "无法播放视频，请重试。"; }
}
function seek(event: Event) {
  if (video.value && canSeek.value) video.value.currentTime = Math.max(0, Math.min(duration.value, Number((event.target as HTMLInputElement).value)));
}
function toggleMute() {
  if (!video.value) return;
  if (video.value.volume === 0) video.value.volume = 1;
  video.value.muted = !muted.value;
}
function setVolume(event: Event) {
  if (!video.value) return;
  video.value.volume = Number((event.target as HTMLInputElement).value);
  video.value.muted = video.value.volume === 0;
}
function syncFullscreen() { fullscreen.value = document.fullscreenElement === player.value; }
async function toggleFullscreen() {
  failure.value = "";
  try {
    if (fullscreen.value) await document.exitFullscreen();
    else await player.value?.requestFullscreen();
  } catch { failure.value = "浏览器未能进入全屏。"; }
}
watch(() => props.src, () => { loop.value = true; time.value = 0; duration.value = 0; playing.value = false; failure.value = ""; });
onMounted(() => document.addEventListener("fullscreenchange", syncFullscreen));
onBeforeUnmount(() => { document.removeEventListener("fullscreenchange", syncFullscreen); video.value?.pause(); });
</script>

<template>
  <div ref="player" class="media-video-player" @pointerdown.stop @click.stop @dblclick.stop>
    <video ref="video" :src="src" :loop="loop" playsinline preload="metadata" @click="togglePlayback" @play="sync" @pause="sync" @ended="sync" @loadedmetadata="sync" @durationchange="sync" @timeupdate="sync" @volumechange="sync" @emptied="sync" @error="failure = '视频加载失败，请重试。'" />
    <p v-if="failure" class="playback-error" role="alert">{{ failure }}</p>
    <div class="playback-controls">
      <input class="playback-seek" type="range" aria-label="视频播放进度" min="0" :max="canSeek ? duration : 0" step="0.01" :value="time" :disabled="!canSeek" @input="seek" />
      <div class="playback-buttons">
        <button type="button" :aria-label="playing ? '暂停' : '播放'" :title="playing ? '暂停' : '播放'" @click="togglePlayback"><v-icon :icon="playing ? 'mdi-pause' : 'mdi-play'" size="20" /></button>
        <span class="playback-time">{{ clock(time) }} / {{ clock(duration) }}</span>
        <div class="playback-volume">
          <input type="range" aria-label="音量" min="0" max="1" step="0.05" :value="volume" @input="setVolume" />
          <button type="button" :aria-label="muted ? '取消静音' : '静音'" :aria-pressed="muted" :title="muted ? '取消静音' : '静音'" @click="toggleMute"><v-icon :icon="muted ? 'mdi-volume-off' : 'mdi-volume-high'" size="19" /></button>
        </div>
        <button type="button" class="loop-toggle" :class="{ enabled: loop }" aria-label="循环播放" :aria-pressed="loop" :title="loop ? '关闭循环播放' : '开启循环播放'" @click="loop = !loop"><v-icon icon="mdi-repeat" size="19" /></button>
        <button type="button" :aria-label="fullscreen ? '退出全屏' : '全屏'" :title="fullscreen ? '退出全屏' : '全屏'" @click="toggleFullscreen"><v-icon :icon="fullscreen ? 'mdi-fullscreen-exit' : 'mdi-fullscreen'" size="20" /></button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.media-video-player { position:relative; width:100%; height:100%; overflow:hidden; background:#000; color:#fff; }
.media-video-player video { display:block; width:100%; height:100%; object-fit:contain; cursor:pointer; }
.playback-controls { position:absolute; inset:auto 0 0; padding:16px 8px 5px; background:linear-gradient(transparent,#000b); }
.playback-seek { display:block; width:100%; height:12px; margin:0 0 3px; accent-color:#fff; cursor:pointer; }
.playback-buttons { display:flex; align-items:center; gap:2px; }
.playback-buttons button { display:flex; align-items:center; justify-content:center; flex:0 0 28px; width:28px; height:28px; padding:0; border:0; border-radius:5px; color:inherit; background:transparent; cursor:pointer; }
.playback-buttons button:hover { background:#ffffff25; }
.playback-buttons button:focus-visible,input:focus-visible { outline:2px solid #8fd6ff; outline-offset:2px; }
.playback-buttons .loop-toggle.enabled { color:#8fd6ff; background:#4db6e52b; }
.playback-time { margin:0 auto 0 3px; white-space:nowrap; font-size:11px; font-variant-numeric:tabular-nums; }
.playback-volume { display:flex; align-items:center; }
.playback-volume input { width:42px; height:12px; accent-color:#fff; }
.playback-error { position:absolute; top:8px; left:8px; right:8px; margin:0; padding:6px; font-size:12px; background:#000b; }
.media-video-player:fullscreen { width:100vw; height:100vh; }
.media-video-player:fullscreen .playback-controls { padding:30px 20px 12px; }
</style>
