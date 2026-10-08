import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import type http from "node:http";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { atomicWriteFileSync } from "../../shared/filePersistence.js";
import { recordDataMutationAudit } from "../../observability/dataMutationAudit.js";
import { XiaomiHomeManagerApiError } from "./managerApi.js";

export const vacuumVideoBinary = { version: "1.9.14", sha256: "923d57252e8139a69c52e4acc1e399a640244a8ef457fd9b7267a25847d68f8c" };
export type VacuumVideoSnapshot = { schemaVersion: 1; sessionId: string; deviceId: string; region: string;
  state: "connecting" | "streaming" | "failed" | "stopped"; startedAt: string; expiresAt?: string;
  firstFrameAt?: string; frameBytes?: number; error?: string; vendor?: string; connectionMode?: "local" | "relay"; pageExit?: "completed" | "uncertain"; workerPid?: number; supervisorPid?: number; parentPid: number; managerPid: number; audio: false };
export type VacuumVideoProvision = { source: string; release: () => Promise<void> };
type ActiveVideo = { snapshot: VacuumVideoSnapshot; child?: ChildProcess; controller: AbortController;
  baseUrl?: string; auth?: string; configPath?: string; release?: () => Promise<void>; closing?: Promise<void> };
const videoError = (code: string, message: string, status = 409) => new XiaomiHomeManagerApiError(status, `xiaomi_vacuum_video_${code}`, message);

/** One provider-owned, video-only MISS transport tied to explicit exit and Manager IPC lifetime. */
export class VacuumVideoTransport {
  private active?: ActiveVideo;
  private starting = false;
  private disposed = false;
  private provisioning?: Promise<VacuumVideoProvision>;
  private readonly root: string;
  constructor(runtimeDir: string, private readonly provision: (deviceId: string, region: string, password?: string, rememberPassword?: boolean) => Promise<VacuumVideoProvision>) {
    this.root = path.join(runtimeDir, "vacuum-video");
  }
  status(sessionId?: string): VacuumVideoSnapshot | { state: "idle"; available: boolean; audio: false } {
    if (!sessionId) return this.active ? { ...this.active.snapshot } : { state: "idle", available: fs.existsSync(path.join(this.root, "go2rtc.exe")), audio: false };
    if (this.active?.snapshot.sessionId === sessionId) return { ...this.active.snapshot };
    if (!/^[0-9a-f-]{36}$/.test(sessionId)) throw videoError("session_invalid", "Invalid video session.", 400);
    const file = path.join(this.root, "sessions", `${sessionId}.json`);
    if (!fs.existsSync(file)) throw videoError("not_found", "Video session not found.", 404);
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as VacuumVideoSnapshot;
    return { ...value, ...(value.state === "connecting" || value.state === "streaming" ? { state: "stopped" as const, error: "manager_restarted" } : {}) };
  }
  async start(deviceId: string, region: string, key: string, password?: string, rememberPassword = false): Promise<VacuumVideoSnapshot> {
    if (!/^\d{1,32}$/.test(deviceId) || !/^[A-Za-z0-9._:-]{16,200}$/.test(key)) throw videoError("request_invalid", "Supply a numeric device and stable action key.", 400);
    if (password !== undefined && !/^\d{4}$/.test(password)) throw videoError("password_invalid", "请输入四位视频密码。", 400);
    if (this.disposed) throw videoError("owner_stopped", "Video owner stopped; discover the current Manager.");
    const keyFile = path.join(this.root, "keys", `${createHash("sha256").update(key).digest("hex")}.json`);
    if (fs.existsSync(keyFile)) {
      const receipt = JSON.parse(fs.readFileSync(keyFile, "utf8"));
      if (receipt.deviceId !== deviceId || receipt.region !== region || Boolean(receipt.rememberPassword) !== rememberPassword) throw videoError("key_conflict", "Video action key belongs to another intent.");
      return this.status(receipt.sessionId) as VacuumVideoSnapshot;
    }
    await this.active?.closing;
    if (this.disposed) throw videoError("owner_stopped", "Video owner stopped; discover the current Manager.");
    if (this.starting || this.active && ["connecting", "streaming"].includes(this.active.snapshot.state)) throw videoError("busy", "A video session is already active; inspect or stop that session.");
    const executable = path.join(this.root, "go2rtc.exe");
    if (process.platform !== "win32" || !fs.existsSync(executable)) throw videoError("component_missing", "Install the pinned Windows MISS transport before starting video.");
    if (createHash("sha256").update(fs.readFileSync(executable)).digest("hex") !== vacuumVideoBinary.sha256) throw videoError("component_invalid", "The MISS transport binary does not match the pinned release.");
    this.starting = true;
    const sessionId = randomUUID(), startedAt = new Date().toISOString();
    const active: ActiveVideo = { controller: new AbortController(), snapshot: {
      schemaVersion: 1, sessionId, deviceId, region, state: "connecting", startedAt,
      parentPid: process.pid, managerPid: process.pid, audio: false
    } };
    this.active = active;
    // Receipt exists before device calls; PIN and PIN hash never enter action receipts.
    this.save(active);
    atomicWriteFileSync(keyFile, JSON.stringify({ deviceId, region, sessionId, rememberPassword }), { mode: 0o600 });
    try {
      this.provisioning = this.provision(deviceId, region, password, rememberPassword);
      password = undefined;
      const provision = await this.provisioning;
      active.release = provision.release;
      if (this.disposed || active.controller.signal.aborted) {
        active.snapshot.state = "stopped"; await this.close(active); return { ...active.snapshot };
      }
      active.snapshot.vendor = new URL(provision.source).searchParams.get("vendor") || undefined;
      active.snapshot.connectionMode = new URL(provision.source).searchParams.has("cs2_peer") ? "relay" : "local";
      this.save(active);
      void this.connect(active, provision.source).catch(async () => { if (!active.controller.signal.aborted) { active.snapshot.state = "failed"; active.snapshot.error ||= "transport_failed"; await this.close(active); } });
      return { ...active.snapshot };
    } catch (cause) {
      active.snapshot.state = active.controller.signal.aborted ? "stopped" : "failed";
      active.snapshot.error = cause instanceof XiaomiHomeManagerApiError ? cause.code : "provision_failed";
      await this.close(active); return { ...active.snapshot };
    } finally { password = undefined; this.provisioning = undefined; this.starting = false; }
  }
  async stop(sessionId: string): Promise<VacuumVideoSnapshot> {
    const snapshot = this.status(sessionId) as VacuumVideoSnapshot;
    if (this.active?.snapshot.sessionId === sessionId) {
      const active = this.active;
      active.snapshot.state = "stopped";
      active.controller.abort();
      await this.provisioning?.catch(() => undefined);
      await this.close(active);
      return { ...active.snapshot };
    }
    return snapshot;
  }
  async shutdown(): Promise<void> { this.disposed = true; if (this.active) await this.stop(this.active.snapshot.sessionId); }
  receipt(key: string): VacuumVideoSnapshot {
    if (!/^[A-Za-z0-9._:-]{16,200}$/.test(key)) throw videoError("key_invalid", "Invalid video action key.", 400);
    const file = path.join(this.root, "keys", `${createHash("sha256").update(key).digest("hex")}.json`);
    if (!fs.existsSync(file)) throw videoError("not_found", "Video action receipt not found.", 404);
    return this.status(JSON.parse(fs.readFileSync(file, "utf8")).sessionId) as VacuumVideoSnapshot;
  }
  private save(active: ActiveVideo): void {
    atomicWriteFileSync(path.join(this.root, "sessions", `${active.snapshot.sessionId}.json`), JSON.stringify(active.snapshot), { mode: 0o600 });
    recordDataMutationAudit({ group: "integration.xiaomi-home", event: "vacuum.video", owner: "VacuumVideoTransport", action: "video.session",
      target: { type: "video-session", id: active.snapshot.sessionId }, dataSource: { kind: "runtime", id: "xiaomi-miss" },
      outcome: active.snapshot.state === "failed" ? "failed" : active.snapshot.state === "stopped" ? "cancelled" : "committed", result: active.snapshot.state });
  }
  private close(active: ActiveVideo): Promise<void> {
    if (active.closing) return active.closing;
    active.controller.abort();
    if (active.child?.connected) active.child.send("stop");
    if (active.configPath && fs.existsSync(active.configPath)) fs.unlinkSync(active.configPath);
    active.closing = (async () => {
      if (active.release) {
        try { await active.release(); active.snapshot.pageExit = "completed"; }
        catch { active.snapshot.pageExit = "uncertain"; }
      }
      this.save(active);
    })();
    return active.closing;
  }
  private async connect(active: ActiveVideo, source: string): Promise<void> {
    const port = await new Promise<number>((resolve, reject) => {
      const reservation = net.createServer(); reservation.once("error", reject);
      reservation.listen(0, "127.0.0.1", () => { const address = reservation.address() as net.AddressInfo; reservation.close(error => error ? reject(error) : resolve(address.port)); });
    });
    if (active.controller.signal.aborted) return;
    const password = randomBytes(24).toString("hex");
    active.baseUrl = `http://127.0.0.1:${port}`; active.auth = `Basic ${Buffer.from(`rabi:${password}`).toString("base64")}`;
    active.configPath = path.join(this.root, `${active.snapshot.sessionId}.yaml`);
    // File and argv contain references only; ephemeral MISS secrets are inherited by this child alone.
    const config = { api: { listen: `127.0.0.1:${port}`, username: "rabi", password: "${RABI_VIDEO_PASSWORD}", local_auth: true,
      allow_paths: ["/api", "/api/frame.mp4", "/api/stream.mp4"] }, rtsp: { listen: "" }, webrtc: { listen: "" },
      log: { level: "disabled" }, streams: { vacuum: "${RABI_VIDEO_SOURCE}" } };
    atomicWriteFileSync(active.configPath, JSON.stringify(config), { mode: 0o600 });
    const child = spawn(process.execPath, [fileURLToPath(new URL("./vacuumVideoWorker.js", import.meta.url)), path.join(this.root, "go2rtc.exe"), active.configPath], {
      windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"], env: { ...process.env, RABI_VIDEO_SOURCE: source, RABI_VIDEO_PASSWORD: password }, cwd: this.root
    });
    active.child = child; active.snapshot.supervisorPid = child.pid;
    child.on("message", message => {
      const value = message as { event?: string; pid?: number; parentPid?: number; code?: string;connectionMode?:"local"|"relay" };
      if(value.event==="connection" && ["local","relay"].includes(value.connectionMode || "")){active.snapshot.connectionMode=value.connectionMode;this.save(active);}
      if (value.event === "ready" && Number.isInteger(value.pid) && Number.isInteger(value.parentPid)) {
        active.snapshot.workerPid = value.pid; active.snapshot.parentPid = value.parentPid!; this.save(active);
      }
      if (value.event === "failed" && /^camera_relay_(?:parameters_invalid|cancelled|discovery_timeout|registration_timeout|allocation_timeout|device_join_timeout|connection_failed)$/.test(value.code || "")) {
        active.snapshot.error = value.code; active.snapshot.state = "failed"; void this.close(active);
      }
    });
    // The persisted session records purpose, PID, parent/source and status; raw native logs can contain key URLs.
    this.save(active);
    child.once("error", () => { active.snapshot.state = "failed"; active.snapshot.error = "worker_start_failed"; void this.close(active); });
    child.once("exit", () => { if (!active.controller.signal.aborted) { active.snapshot.state = "failed"; active.snapshot.error ||= "worker_exited"; void this.close(active); } });
    let ready = false;
    const readyDeadline = Date.now() + (active.snapshot.connectionMode === "relay" ? 45000 : 10000);
    while (Date.now() < readyDeadline && !active.controller.signal.aborted) {
      try { const response = await fetch(`${active.baseUrl}/api`, { headers: { Authorization: active.auth }, signal: AbortSignal.any([active.controller.signal, AbortSignal.timeout(1000)]) }); if (response.ok) { await response.body?.cancel(); ready = true; break; } } catch { /* Only this owned address is retried. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready || active.controller.signal.aborted) throw videoError("startup_failed", "Video transport did not become ready.");
    // Keep one video-only consumer alive: a keyframe consumer closes the MISS producer
    // before the browser can subscribe, invalidating the established relay endpoint.
    const initial = new AbortController();
    const frameDeadline = setTimeout(() => initial.abort(), 25000);
    let held: Awaited<ReturnType<typeof holdVideoStream>>;
    try {
      const frame = await fetch(`${active.baseUrl}/api/stream.mp4?src=vacuum&video=h264,h265`, { headers: { Authorization: active.auth }, signal: AbortSignal.any([active.controller.signal, initial.signal]) });
      if (!frame.ok) {
        active.snapshot.error = safeVideoFailure(await boundedErrorText(frame));
        throw videoError("camera_rejected", "The camera did not provide a video frame.");
      }
      held = await holdVideoStream(frame, active.controller.signal);
    } finally { clearTimeout(frameDeadline); }
    if (active.controller.signal.aborted) return;
    active.snapshot.state = "streaming"; active.snapshot.firstFrameAt = new Date().toISOString(); active.snapshot.frameBytes = held.bytes; this.save(active);
    void held.completed.catch(async () => {
      if (!active.controller.signal.aborted) { active.snapshot.state = "failed"; active.snapshot.error = "camera_stream_interrupted"; await this.close(active); }
    });
  }
  async stream(sessionId: string, response: http.ServerResponse, frame = false): Promise<void> {
    if (this.active?.snapshot.sessionId !== sessionId || this.active.snapshot.state !== "streaming") throw videoError("not_ready", "Video frames are not available yet.");
    const active = this.active, controller = new AbortController();
    const close = () => controller.abort(); response.once("close", close);
    try {
      const upstream = await fetch(`${active.baseUrl}/api/${frame ? "frame" : "stream"}.mp4?src=vacuum&video=h264,h265`, {
        headers: { Authorization: active.auth! }, signal: AbortSignal.any(frame
          ? [controller.signal, active.controller.signal, AbortSignal.timeout(25000)]
          : [controller.signal, active.controller.signal]) });
      if (!upstream.ok || !upstream.body) { await upstream.body?.cancel(); throw videoError("stream_failed", "Video stream interrupted.", 502); }
      response.writeHead(200, { "Content-Type": upstream.headers.get("content-type") || "video/mp4", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      await pipeline(Readable.fromWeb(upstream.body as never), response);
    } finally { response.off("close", close); }
  }
}

async function boundedErrorText(response: Response): Promise<string> {
  const reader = response.body?.getReader(); if (!reader) return "";
  const chunks: Uint8Array[] = []; let length = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break;
    length += next.value.length; if (length > 16384) { await reader.cancel(); return ""; } chunks.push(next.value); }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}

/** Validate the first complete MP4 fragment, then drain without storing footage until owner cancellation. */
export async function holdVideoStream(response: Response, signal: AbortSignal): Promise<{ bytes: number; completed: Promise<void> }> {
  const reader = response.body?.getReader();
  if (!reader) throw videoError("frame_invalid", "No video frame received.", 502);
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, {once:true});
  let data = Buffer.alloc(0), offset = 0, count = 0;
  const boxes = new Set<string>();
  try {
    for (;;) {
      if (signal.aborted) throw videoError("cancelled", "Video owner stopped.");
      const next = await reader.read();
      if (next.done) throw videoError("frame_invalid", "Video ended before its first MP4 frame.", 502);
      if (data.length + next.value.length > 4 * 1024 * 1024) throw videoError("frame_invalid", "Video frame exceeds bounds.", 502);
      data = Buffer.concat([data, next.value]);
      while (offset + 8 <= data.length) {
        const size = data.readUInt32BE(offset), type = data.subarray(offset+4,offset+8).toString("ascii");
        if (size < 8 || size > 4 * 1024 * 1024 || offset === 0 && type !== "ftyp") throw videoError("frame_invalid", "The transport did not return an MP4 frame.", 502);
        if (offset + size > data.length) break;
        if (++count > 64 || type === "mdat" && size <= 8) throw videoError("frame_invalid", "The transport did not return an MP4 frame.", 502);
        boxes.add(type); offset += size;
        if (["ftyp","moov","moof","mdat"].every(value => boxes.has(value))) {
          const bytes = offset; data = Buffer.alloc(0);
          const completed = (async () => {
            try {
              while (!signal.aborted) { const chunk = await reader.read(); if (chunk.done) { if (signal.aborted) return; throw videoError("stream_failed", "Video stream interrupted.", 502); } }
            } finally { signal.removeEventListener("abort", cancel); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
          })();
          // The caller attaches its lifecycle handler after receiving the first-frame result.
          void completed.catch(() => undefined);
          return {bytes, completed};
        }
      }
    }
  } catch (error) { signal.removeEventListener("abort", cancel); await reader.cancel().catch(() => undefined); reader.releaseLock(); throw error; }
}

/** Fixed diagnostic categories only; native errors may contain MISS URLs and key material. */
export function safeVideoFailure(text: string): string {
  if (/miss: auth:/i.test(text)) return "camera_auth_rejected";
  if (/timeout|timed out|deadline/i.test(text)) return "camera_connection_timeout";
  if (/refused|unreachable|no route/i.test(text)) return "camera_lan_unreachable";
  if (/unsupported vendor/i.test(text)) return "camera_vendor_unsupported";
  if (/no video|probe:/i.test(text)) return "camera_video_missing";
  if (/codec|unsupported media/i.test(text)) return "camera_codec_unsupported";
  if (/decode|decrypt|packet header/i.test(text)) return "camera_packet_invalid";
  return "camera_connection_rejected";
}
