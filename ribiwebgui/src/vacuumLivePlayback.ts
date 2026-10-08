const startupBufferSeconds = 0.3;

/** One pacing state per player. Buffer lag excludes camera and network delay. */
export class LivePlaybackPacer {
  private catchUpSinceMs: number | undefined;
  private largeLagSinceMs: number | undefined;
  private lastSeekMs = -Infinity;
  private catchingUp = false;

  update(current: number, start: number, end: number, nowMs: number) {
    if (![current, start, end, nowMs].every(Number.isFinite) || end <= start) return undefined;
    const gap = Math.max(0, end - current);
    if (gap > 0.65) this.catchUpSinceMs ??= nowMs;
    else this.catchUpSinceMs = undefined;
    if (gap > 1.5) this.largeLagSinceMs ??= nowMs;
    else this.largeLagSinceMs = undefined;

    // Ordinary packet/frame jitter must not reset the decoder or repeatedly change speed.
    const sustainedLargeLag = this.largeLagSinceMs !== undefined && nowMs - this.largeLagSinceMs >= 1000;
    if (current < start || sustainedLargeLag && nowMs - this.lastSeekMs >= 5000) {
      this.lastSeekMs = nowMs;
      this.catchUpSinceMs = this.largeLagSinceMs = undefined;
      this.catchingUp = false;
      return {gap, seekTo: Math.max(start, end - startupBufferSeconds), playbackRate: 1};
    }
    if (gap < 0.4) this.catchingUp = false;
    else if (this.catchUpSinceMs !== undefined && nowMs - this.catchUpSinceMs >= 1000) this.catchingUp = true;
    return {gap, seekTo: undefined, playbackRate: this.catchingUp ? 1.03 : 1};
  }
}

function waitFor(target: EventTarget, event: string, signal: AbortSignal, operation?: () => void) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {clearTimeout(timeout); target.removeEventListener(event, done); target.removeEventListener("error", failed); signal.removeEventListener("abort", aborted);};
    const done = () => {cleanup(); resolve();};
    const failed = () => {cleanup(); reject(new Error("视频解码失败。"));};
    const aborted = () => {cleanup(); reject(signal.reason);};
    const timeout = setTimeout(() => {cleanup(); reject(new Error("视频数据处理超时，请退出后重新连接。"));}, 10000);
    target.addEventListener(event, done, {once: true}); target.addEventListener("error", failed, {once: true}); signal.addEventListener("abort", aborted, {once: true});
    if (signal.aborted) {aborted(); return;}
    try {operation?.();} catch (error) {cleanup(); reject(error);}
  });
}

/** Consume the existing video-only stream, retaining five seconds and following its latest frame. */
export function startVacuumLivePlayback(video: HTMLVideoElement, url: string, onGap: (seconds: number) => void) {
  const controller = new AbortController();
  let objectUrl: string | undefined;
  let playRequested = false;
  const pacer = new LivePlaybackPacer();
  const stop = () => {
    controller.abort();
    if (objectUrl) {
      if (video.src === objectUrl) {video.pause(); video.removeAttribute("src"); video.load();}
      URL.revokeObjectURL(objectUrl); objectUrl = undefined;
    }
  };
  const finished = (async () => {
    if (typeof MediaSource === "undefined") throw new Error("当前浏览器不支持低延迟视频，请使用新版 Chrome 或 Edge。");
    const source = new MediaSource();
    objectUrl = URL.createObjectURL(source);
    await waitFor(source, "sourceopen", controller.signal, () => {video.src = objectUrl!;});
    const response = await fetch(url, {signal: controller.signal, cache: "no-store"});
    if (!response.ok || !response.body) throw new Error("视频流不可用，请退出后重新连接。");
    const mime = response.headers.get("content-type") || "";
    if (!/^video\/mp4;\s*codecs="[A-Za-z0-9., -]+"$/.test(mime) || !MediaSource.isTypeSupported(mime)) throw new Error("当前浏览器不支持设备返回的视频格式。");
    const buffer = source.addSourceBuffer(mime);
    source.duration = Infinity;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const chunk = await reader.read();
        controller.signal.throwIfAborted();
        if (chunk.done) throw new Error("视频流已中断，请退出后重新连接。");
        if (chunk.value.byteLength > 8 * 1024 * 1024) throw new Error("视频数据超出处理范围。");
        await waitFor(buffer, "updateend", controller.signal, () => buffer.appendBuffer(chunk.value));
        if (!buffer.buffered.length) continue;
        const start = buffer.buffered.start(0), end = buffer.buffered.end(buffer.buffered.length - 1);
        const correction = pacer.update(video.currentTime, start, end, performance.now());
        if (correction) {
          if (correction.seekTo !== undefined) video.currentTime = correction.seekTo;
          if (video.playbackRate !== correction.playbackRate) video.playbackRate = correction.playbackRate;
          onGap(Math.max(0, end - video.currentTime));
        }
        source.setLiveSeekableRange(start, end);
        // Playback may wait for later frames. Never block their ingestion on its promise.
        if (video.paused && !playRequested && end - start >= startupBufferSeconds) {
          playRequested = true;
          void video.play().catch(() => controller.abort(new Error("视频无法开始播放，请退出后重新连接。")));
        }
        if (end - start > 6) await waitFor(buffer, "updateend", controller.signal, () => buffer.remove(start, end - 5));
      }
    } finally {await reader.cancel().catch(() => undefined); reader.releaseLock();}
  })().finally(stop);
  return {stop, finished};
}
