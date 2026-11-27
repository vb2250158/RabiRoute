
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { promisify } from "node:util";
import { DEFAULT_COMPUTER_SETTINGS } from "./computer-control-contract.mjs";
import { RecordingStorage, recordingMovieName, recordingIdPattern as idPattern, recordingIsTerminal as isTerminal } from "./screen-recording-storage.mjs";

const exec = promisify(execFile);
const actions = new Set(["recording.start", "recording.status", "recording.pause", "recording.resume", "recording.stop",
  "recording.save", "recording.clip", "recording.cache.status"]);
const lossless = ["-an", "-c:v", "ffv1", "-level", "3", "-pix_fmt", "bgr0"];

function capture(executable, target, file, fps, durationSeconds, captureWindow, byteLimit) {
  const input = target
    ? ["-f", "image2pipe", "-vcodec", "png", "-framerate", String(fps), "-i", "pipe:0"]
    : ["-f", "gdigrab", "-draw_mouse", "0", "-framerate", String(fps), "-i", "desktop"];
  const child = spawn(executable, ["-hide_banner", "-loglevel", "error", "-n", ...input,
    "-t", String(durationSeconds), "-fs", String(byteLimit), ...lossless, file],
  { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
  const stopping = new AbortController();
  let diagnostic = "", producerError;
  child.stderr.on("data", bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-1500); });
  child.stdin.on("error", () => {});
  const done = new Promise(resolve => {
    child.once("error", error => { stopping.abort(); resolve({ error: error.message }); });
    child.once("close", code => {
      stopping.abort();
      resolve(code === 0 && !producerError ? {} : { error: producerError || diagnostic.trim() || "Recorder exited with code " + code });
    });
  });
  const pump = target && (async () => {
    let dimensions;
    try {
      while (!stopping.signal.aborted) {
        const start = performance.now();
        const frame = await captureWindow(target, stopping.signal);
        if (stopping.signal.aborted) break;
        const size = frame.width + "x" + frame.height;
        if (dimensions && size !== dimensions) throw new Error("A recording window changed size.");
        dimensions = size;
        await new Promise((resolve, reject) => child.stdin.write(Buffer.from(frame.data, "base64"),
          error => error ? reject(error) : resolve()));
        await delay(Math.max(0, 1000 / fps - (performance.now() - start)), undefined, { signal: stopping.signal });
      }
    } catch (error) {
      if (!stopping.signal.aborted) producerError = error.message;
    } finally {
      child.stdin.end();
    }
  })();
  return { done, async stop() {
    stopping.abort();
    if (child.exitCode === null && child.signalCode === null) child.stdin.end(target ? undefined : "q\n");
    const kill = setTimeout(() => child.kill(), 8000);
    try {
      const result = await done;
      await pump;
      return result;
    } finally { clearTimeout(kill); }
  } };
}

function recordingOptions(input, now) {
  const startAt = input.startAt ?? now;
  const endAt = input.endAt;
  const fps = input.fps ?? 15;
  const pauses = (input.pauses ?? []).map(({ startAt, endAt }) => ({ startAt, endAt })).sort((a, b) => a.startAt - b.startAt);
  if (!Number.isSafeInteger(startAt) || startAt < 0 ||
      !Number.isSafeInteger(endAt) || endAt <= Math.max(startAt, now)) throw new Error("A future endAt after startAt is required (Unix milliseconds).");
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) throw new Error("fps must be 1–60.");
  if (pauses.length > 32 || pauses.some((pause, i) => !Number.isSafeInteger(pause.startAt) || !Number.isSafeInteger(pause.endAt) ||
      pause.startAt < startAt || pause.endAt <= pause.startAt || pause.endAt > endAt || i && pause.startAt < pauses[i - 1].endAt)) {
    throw new Error("Pause intervals must be ordered, non-overlapping and within the recording.");
  }
  const windows = (input.windows ?? []).map(({ windowId, pid }) => ({ windowId: String(windowId).toLowerCase(), pid }));
  if (windows.length > 8 || windows.some(window => !/^[a-f0-9]{1,16}$/.test(window.windowId) || !Number.isSafeInteger(window.pid) || window.pid < 1) ||
      new Set(windows.map(window => window.windowId)).size !== windows.length) throw new Error("Use distinct windowId and pid pairs from windows.list.");
  return { startAt, endAt, fps, pauses, windows };
}

/** Owns schedules and native encoders on the selected Windows device. */
export class ScreenRecording {
  constructor({ root, listWindows, captureWindow, authorize, present = async () => ({ visible: true }), changed = () => {}, policy = () => DEFAULT_COMPUTER_SETTINGS.recording, executable = process.env.RABI_AGENT_FFMPEG || "ffmpeg.exe", openCapture = capture, now = Date.now }) {
    Object.assign(this, { root, listWindows, captureWindow, authorize, present, changed, executable, openCapture, now });
    this.storage = new RecordingStorage(root, policy, now);
    if (root && process.platform === "win32") {
      this.cleanup = setInterval(() => {
        void this.serialize(() => {
          if (!this.storage.policy().retentionDays) return;
          const active = [...this.jobs.values()].find(job => !isTerminal(job));
          return this.storage.inventory([active?.id, active?.sourceRecordingId], true);
        }).catch(() => {});
      }, 300_000);
      this.cleanup.unref();
    }
    this.jobs = new Map();
    this.operations = Promise.resolve();
  }

  get activeCount() {
    return [...this.jobs.values()].some(job => !isTerminal(job)) ? 1 : 0;
  }

  serialize(action) {
    const result = this.operations.then(action);
    this.operations = result.catch(() => {});
    return result;
  }

  view(job) {
    if (!job) return { state: "absent" };
    return { recordingId: job.id, state: job.state, startAt: job.startAt, endAt: job.endAt, fps: job.fps,
      pauses: job.pauses, windows: job.windows, permanent: job.permanent === true,
      ...(job.finishedAt ? { finishedAt: job.finishedAt, expiresAt: this.storage.expiresAt(job) } : {}),
      ...(job.sourceRecordingId ? { sourceRecordingId: job.sourceRecordingId } : {}),
      files: job.files.slice(), ...(job.error ? { error: job.error } : {}) };
  }

  execute(input, guard, sourceLabel = "Rabi Agent") {
    return this.serialize(async () => {
      guard?.();
      if (this.closed) throw new Error("Recording service is stopped.");
      if (!actions.has(input.action)) throw new Error("Unsupported recording action.");
      if (input.action === "recording.cache.status") return { state: "ready", ...await this.storage.inventory(undefined, false) };
      const id = input.recordingId?.toLowerCase();
      if ((id || input.action !== "recording.status") && !idPattern.test(id ?? "")) throw new Error("A UUID recordingId is required.");
      const memory = id ? this.jobs.get(id) : [...this.jobs.values()].at(-1);
      const job = memory && !isTerminal(memory) ? memory : undefined;
      const recorded = this.view(job);
      if (input.action === "recording.status") return job ? recorded : await this.saved(id ?? await this.latestId()) ?? recorded;
      if (input.action === "recording.save") {
        const saved = job ? this.view(job) : await this.saved(id);
        if (!saved || saved.state === "expired") throw new Error("The recording is unavailable or already expired.");
        guard?.();
        const permanent = { ...saved, permanent: true, ...(saved.finishedAt ? { expiresAt: null } : {}) };
        await this.storage.write(permanent);
        if (job) job.permanent = true;
        return permanent;
      }
      if (input.action === "recording.clip") return this.clip(input, id, guard);
      if (input.action === "recording.start") {
        if (job) return recorded;
        const saved = await this.saved(id);
        if (saved) return saved;
        if (!this.root) throw new Error("Recording storage is unavailable on this device.");
        if ([...this.jobs.values()].some(existing => !isTerminal(existing))) throw new Error("This device already has an active or scheduled recording.");
        const options = recordingOptions(input, this.now());
        if (options.endAt - Math.max(this.now(), options.startAt) > this.storage.policy().maxDurationMinutes * 60_000) {
          throw new Error("The requested recording exceeds the device maximum duration.");
        }
        await fs.mkdir(this.root, { recursive: true });
        const directory = path.join(this.root, id);
        guard?.();
        await fs.mkdir(directory);
        const next = { ...options, id, directory, permanent: input.permanent === true, state: "scheduled", sourceLabel: String(sourceLabel).slice(0, 120), files: [], tracks: [], segment: 0, manualPause: false };
        await this.register(next, guard);
        await this.advance(next);
        return this.view(next);
      }
      if (!job || isTerminal(job)) return job ? recorded : await this.saved(id ?? await this.latestId()) ?? recorded;
      if (job.state === "clipping") {
        if (input.action === "recording.stop") job.abort.abort();
        return this.view(job);
      }
      if (input.action === "recording.pause") job.manualPause = true;
      if (input.action === "recording.resume") job.manualPause = false;
      if (input.action === "recording.stop") job.stopRequested = true;
      await this.advance(job);
      return this.view(job);
    });
  }

  async latestId() {
    if (!this.root) return undefined;
    const id = await fs.readFile(path.join(this.root, "latest"), "utf8").catch(error => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    return idPattern.test(id) ? id : undefined;
  }

  async saved(id) {
    const state = await this.storage.read(id);
    if (!state) return null;
    if (isTerminal(state)) return state.finishedAt ? { ...state, expiresAt: this.storage.expiresAt(state) } : state;
    return { ...state, state: "failed", error: "The recording owner restarted before completion. The old schedule was not restarted." };
  }

  save(job) { return this.storage.write(this.view(job)); }

  async register(job, guard) {
    await this.save(job);
    await this.storage.atomic(path.join(this.root, "latest"), job.id);
    guard?.();
    for (const [key, previous] of this.jobs) if (isTerminal(previous)) this.jobs.delete(key);
    this.jobs.set(job.id, job);
  }

  async clip(input, id, guard) {
    const original = await this.saved(id);
    if (original) return this.jobs.has(id) ? this.view(this.jobs.get(id)) : original;
    if (this.activeCount) throw new Error("Wait for the active recording or clip to finish.");
    const source = await this.saved(input.sourceRecordingId?.toLowerCase());
    const { startAt, endAt } = input;
    if (!source?.files?.length || !isTerminal(source)) throw new Error("A completed source recording is required.");
    if (!Number.isSafeInteger(startAt) || !Number.isSafeInteger(endAt) || startAt >= endAt) throw new Error("Select a valid recording time range.");
    if (endAt - startAt > this.storage.policy().maxDurationMinutes * 60_000) throw new Error("The requested clip exceeds the device maximum duration.");
    const ranges = source.files.flatMap(file => {
      const from = Math.max(startAt, file.startedAt);
      const until = Math.min(endAt, file.endedAt);
      return until > from ? [{ file, from, until }] : [];
    });
    if (!ranges.length) throw new Error("The selected range contains no saved video.");
    const directory = path.join(this.root, id);
    guard?.();
    await fs.mkdir(directory);
    const job = { id, directory, sourceRecordingId: source.recordingId, startAt, endAt, fps: source.fps, pauses: [], windows: source.windows,
      permanent: input.permanent === true, state: "clipping", abort: new AbortController(), files: [], tracks: [] };
    await this.register(job, guard);
    job.work = this.runClip(job, source, ranges);
    void job.work.then(result => this.serialize(() => this.finishClip(job, result))).catch(() => {});
    return this.view(job);
  }

  async runClip(job, source, ranges) {
    try {
      for (const [i, { file, from, until }] of ranges.entries()) {
        job.abort.signal.throwIfAborted();
        const name = path.basename(file.path);
        if (!recordingMovieName.test(name)) throw new Error("Invalid source video filename.");
        const input = path.join(this.root, source.recordingId, name);
        const output = path.join(job.directory, "segment-" + (i + 1) + "-track-1.mkv");
        const available = await this.storage.availableBytes(this.view(job), 1, false);
        try {
          await exec(this.executable, ["-hide_banner", "-loglevel", "error", "-n", "-ss", String((from - file.startedAt) / 1000),
            "-i", input, "-t", String((until - from) / 1000), "-fs", String(available), ...lossless, output],
          { windowsHide: true, signal: job.abort.signal });
          const stat = await fs.stat(output);
          if (!stat.size || stat.size >= available) throw new Error("Clip exceeds the available recording capacity.");
          job.files.push({ path: output, size: stat.size, window: file.window, mimeType: "video/x-matroska", startedAt: from, endedAt: until });
        } catch (error) {
          await fs.unlink(output).catch(() => {});
          throw error;
        }
      }
      return { state: "completed" };
    } catch (error) {
      return { state: job.abort.signal.aborted ? "cancelled" : "failed", error: error.message };
    }
  }

  async finishClip(job, result) {
    if (isTerminal(job)) return;
    Object.assign(job, result, { finishedAt: this.now() });
    await this.save(job);
    this.changed();
  }

  async verifyWindows(job) {
    if (!job.windows.length) return;
    const listed = await this.listWindows();
    for (const window of job.windows) {
      if (!listed.windows.some(row => row.windowId.toLowerCase() === window.windowId && row.pid === window.pid && !row.minimized)) {
        throw new Error("A selected window closed, was minimized, or changed identity.");
      }
    }
  }

  async stopTracks(job) {
    const tracks = job.tracks.splice(0);
    const outputs = await Promise.all(tracks.map(async track => {
      const result = await track.capture.stop();
      const stat = await fs.stat(track.path).catch(() => null);
      const file = !result.error && stat?.size ? { path: track.path, size: stat.size, window: track.window, mimeType: "video/x-matroska",
        startedAt: track.startedAt, endedAt: Math.min(this.now(), track.deadline) } : null;
      return { file, error: result.error };
    }));
    job.files.push(...outputs.flatMap(output => output.file ? [output.file] : []));
    return outputs.flatMap(output => output.error ? [output.error] : []).join("\n");
  }

  async advance(job) {
    clearTimeout(job.timer);
    const now = this.now();
    const previous = job.state;
    const present = state => {
      if (state === "recording" || state === "paused") job.presented = true;
      return this.present({ state, recordingId: job.id, sourceLabel: job.sourceLabel });
    };
    try {
      if (job.stopRequested || now >= job.endAt) {
        const stopError = await this.stopTracks(job);
        job.error ||= stopError;
        job.state = job.error ? "failed" : job.files.length ? "completed" : "cancelled";
        return;
      }
      this.authorize();
      const pause = job.pauses.find(item => item.startAt <= now && now < item.endAt);
      if (now < job.startAt || pause || job.manualPause) {
        const error = await this.stopTracks(job);
        if (error) throw new Error(error);
        job.state = now < job.startAt && !job.manualPause ? "scheduled" : "paused";
        if (job.state === "paused") await present("paused");
      } else {
        await this.verifyWindows(job);
        const nextPause = job.pauses.find(item => item.startAt > now)?.startAt ?? job.endAt;
        const deadline = Math.min(job.endAt, nextPause);
        if (this.now() >= deadline) { await this.advance(job); return; }
        const banner = await present("recording");
        if (!banner?.visible) throw new Error("The selected device could not display the recording banner.");
        if (this.now() >= deadline) { await this.advance(job); return; }
        if (!job.tracks.length) {
          const byteLimit = await this.storage.availableBytes(this.view(job), Math.max(1, job.windows.length));
          if (this.now() >= deadline) { await this.advance(job); return; }
          job.segment++;
          for (const [index, window] of (job.windows.length ? job.windows : [null]).entries()) {
            const file = path.join(job.directory, "segment-" + job.segment + "-track-" + (index + 1) + ".mkv");
            const startedAt = this.now();
            const track = { path: file, window, startedAt, deadline,
              capture: this.openCapture(this.executable, window, file, job.fps, (deadline - startedAt) / 1000 + 2, this.captureWindow, byteLimit) };
            job.tracks.push(track);
            void track.capture.done.then(result => this.serialize(async () => {
              if (!job.tracks.includes(track)) return;
              job.error = result.error || "The recording reached its capacity limit or the encoder stopped early.";
              job.stopRequested = true;
              await this.advance(job);
            })).catch(() => {});
          }
        }
        job.state = "recording";
      }
      const transitions = [job.startAt, job.endAt, ...job.pauses.flatMap(p => [p.startAt, p.endAt])];
      const next = Math.min(...transitions.filter(value => value > now), ["recording", "paused"].includes(job.state) ? now + 1000 : Infinity);
      job.timer = setTimeout(() => void this.serialize(() => this.advance(job)).catch(error => { job.error = error.message; }), Math.min(2_147_483_647, Math.max(0, next - this.now())));
      job.timer.unref();
    } catch (error) {
      job.error = error.message;
      await this.stopTracks(job);
      job.state = "failed";
    } finally {
      if (isTerminal(job)) job.finishedAt ??= this.now();
      if (isTerminal(job) && job.presented) await present(job.state).catch(() => {});
      if (job.state !== previous) {
        await this.save(job);
        this.changed();
      }
    }
  }

  close() {
    this.closed = true;
    clearInterval(this.cleanup);
    return this.serialize(async () => {
      for (const job of this.jobs.values()) {
        if (isTerminal(job)) continue;
        if (job.state === "clipping") { job.abort.abort(); await this.finishClip(job, await job.work); continue; }
        job.stopRequested = true;
        await this.advance(job);
      }
    });
  }
}
