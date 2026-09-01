import { createDecipheriv, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { XiaomiHomeArtifactPublicRecord } from "./artifactStore.js";
import { XiaomiHomeArtifactStore } from "./artifactStore.js";

export type XiaomiMiotMotionClipCandidate = {
  sourceEventId: string;
  resourceId: string;
  resourceName: string;
  occurredAt: string;
  eventType: string;
  playlistUrl: string;
  thumbnailUrl?: string;
};

export type XiaomiHomeClipCaptureConfig = {
  cameraClipCaptureEnabled?: boolean;
  cameraClipAllowedHosts?: readonly string[];
  ffmpegPath?: string;
  ffprobePath?: string;
  cameraClipRequestTimeoutMs?: number;
  cameraClipMaxSegments?: number;
  cameraClipMaxSegmentBytes?: number;
};

type FetchLike = typeof fetch;

type HlsKey = { method: "AES-128"; uri: URL; iv?: Buffer } | { method: "NONE" };
type HlsSegment = { uri: URL; key: HlsKey; sequence: number };

function safeToolPath(input: string | undefined, fallback: string): string {
  const value = String(input || fallback).trim();
  if (!value) throw new Error(`${fallback} path is required.`);
  return value;
}

function normalizedAllowedHosts(input: readonly string[] | undefined): string[] {
  return (input ?? []).map(value => String(value ?? "").trim().toLowerCase()).filter(value => /^(\*\.)?[a-z0-9.-]+$/.test(value));
}

function hostAllowed(hostname: string, allowedHosts: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return allowedHosts.some(pattern => pattern.startsWith("*.")
    ? host.endsWith(pattern.slice(1)) && host !== pattern.slice(2)
    : host === pattern);
}

function validateMediaUrl(value: string | URL, allowedHosts: readonly string[]): URL {
  const url = value instanceof URL ? value : new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || !hostAllowed(url.hostname, allowedHosts)) {
    throw new Error(`Camera media host is not allowed: ${url.hostname || "invalid"}.`);
  }
  return url;
}

function parseAttributeList(line: string): Record<string, string> {
  const result: Record<string, string> = {};
  const body = line.slice(line.indexOf(":") + 1);
  for (const match of body.matchAll(/(?:^|,)([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
    result[match[1]] = match[2].replace(/^"|"$/g, "");
  }
  return result;
}

function sequenceIv(sequence: number): Buffer {
  const iv = Buffer.alloc(16);
  iv.writeBigUInt64BE(BigInt(sequence), 8);
  return iv;
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", chunk => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

export function parseHlsMediaPlaylist(text: string, playlistUrl: URL, allowedHosts: readonly string[]): HlsSegment[] {
  const lines = text.replace(/\r/g, "").split("\n").map(line => line.trim()).filter(Boolean);
  if (!lines.includes("#EXTM3U")) throw new Error("Camera clip did not return an HLS playlist.");
  const mediaSequenceLine = lines.find(line => line.startsWith("#EXT-X-MEDIA-SEQUENCE:"));
  const mediaSequence = mediaSequenceLine ? Number(mediaSequenceLine.split(":", 2)[1]) : 0;
  let currentKey: HlsKey = { method: "NONE" };
  const segments: HlsSegment[] = [];
  for (const line of lines) {
    if (line.startsWith("#EXT-X-KEY:")) {
      const attrs = parseAttributeList(line);
      if (attrs.METHOD === "NONE") {
        currentKey = { method: "NONE" };
      } else if (attrs.METHOD === "AES-128" && attrs.URI) {
        const ivHex = String(attrs.IV || "").replace(/^0x/i, "");
        if (ivHex && !/^[a-f0-9]{32}$/i.test(ivHex)) throw new Error("Camera clip HLS IV is invalid.");
        currentKey = {
          method: "AES-128",
          uri: validateMediaUrl(new URL(attrs.URI, playlistUrl), allowedHosts),
          iv: ivHex ? Buffer.from(ivHex, "hex") : undefined
        };
      } else {
        throw new Error("Camera clip uses an unsupported HLS encryption method.");
      }
    } else if (!line.startsWith("#")) {
      segments.push({
        uri: validateMediaUrl(new URL(line, playlistUrl), allowedHosts),
        key: currentKey,
        sequence: mediaSequence + segments.length
      });
    }
  }
  if (!segments.length) throw new Error("Camera clip HLS playlist has no media segments.");
  return segments;
}

export class XiaomiHomeClipCaptureWorker {
  private readonly enabled: boolean;
  private readonly allowedHosts: string[];
  private readonly ffmpegPath: string;
  private readonly ffprobePath: string;
  private readonly requestTimeoutMs: number;
  private readonly maxSegments: number;
  private readonly maxSegmentBytes: number;
  private readonly inFlight = new Map<string, Promise<XiaomiHomeArtifactPublicRecord>>();

  constructor(
    config: XiaomiHomeClipCaptureConfig,
    private readonly artifacts: XiaomiHomeArtifactStore,
    private readonly fetchImpl: FetchLike = fetch
  ) {
    this.enabled = config.cameraClipCaptureEnabled === true;
    this.allowedHosts = normalizedAllowedHosts(config.cameraClipAllowedHosts);
    this.ffmpegPath = safeToolPath(config.ffmpegPath, "ffmpeg");
    this.ffprobePath = safeToolPath(config.ffprobePath, "ffprobe");
    this.requestTimeoutMs = Math.min(30000, Math.max(1000, Number(config.cameraClipRequestTimeoutMs ?? 10000)));
    this.maxSegments = Math.min(500, Math.max(1, Number(config.cameraClipMaxSegments ?? 120)));
    this.maxSegmentBytes = Math.min(128 * 1024 * 1024, Math.max(1024, Number(config.cameraClipMaxSegmentBytes ?? 32 * 1024 * 1024)));
  }

  isEnabled(): boolean {
    return this.enabled && this.allowedHosts.length > 0;
  }

  status(): Record<string, unknown> {
    return {
      enabled: this.enabled,
      ready: this.isEnabled(),
      allowedHostCount: this.allowedHosts.length,
      inFlight: this.inFlight.size
    };
  }

  capture(candidate: XiaomiMiotMotionClipCandidate): Promise<XiaomiHomeArtifactPublicRecord> {
    if (!this.isEnabled()) return Promise.reject(new Error("Camera clip capture is not enabled or has no allowed media hosts."));
    const captured = this.artifacts.getBySourceEventId(candidate.sourceEventId);
    if (captured) return Promise.resolve(captured);
    const existing = this.inFlight.get(candidate.sourceEventId);
    if (existing) return existing;
    const operation = this.captureOnce(candidate).finally(() => this.inFlight.delete(candidate.sourceEventId));
    this.inFlight.set(candidate.sourceEventId, operation);
    return operation;
  }

  private async fetchBytes(url: URL, maxBytes: number, redirects = 0): Promise<Buffer> {
    validateMediaUrl(url, this.allowedHosts);
    const response = await this.fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(this.requestTimeoutMs) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects >= 4) throw new Error("Camera media returned too many redirects.");
      const location = response.headers.get("location");
      if (!location) throw new Error("Camera media redirect has no target.");
      return this.fetchBytes(validateMediaUrl(new URL(location, url), this.allowedHosts), maxBytes, redirects + 1);
    }
    if (!response.ok) throw new Error(`Camera media request failed with HTTP ${response.status}.`);
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > maxBytes) throw new Error("Camera media response exceeds the configured size limit.");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error("Camera media response exceeds the configured size limit.");
    return bytes;
  }

  private async mediaPlaylist(initial: URL): Promise<{ url: URL; segments: HlsSegment[] }> {
    const firstText = (await this.fetchBytes(initial, 1024 * 1024)).toString("utf8");
    const lines = firstText.replace(/\r/g, "").split("\n").map(line => line.trim()).filter(Boolean);
    const masterIndex = lines.findIndex(line => line.startsWith("#EXT-X-STREAM-INF:"));
    if (masterIndex >= 0) {
      const variant = lines.slice(masterIndex + 1).find(line => !line.startsWith("#"));
      if (!variant) throw new Error("Camera clip master playlist has no media variant.");
      const variantUrl = validateMediaUrl(new URL(variant, initial), this.allowedHosts);
      const variantText = (await this.fetchBytes(variantUrl, 1024 * 1024)).toString("utf8");
      return { url: variantUrl, segments: parseHlsMediaPlaylist(variantText, variantUrl, this.allowedHosts) };
    }
    return { url: initial, segments: parseHlsMediaPlaylist(firstText, initial, this.allowedHosts) };
  }

  private runTool(executable: string, args: string[], workingDirectory: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { cwd: workingDirectory, windowsHide: true, stdio: ["ignore", "ignore", "ignore"] });
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error("Camera media tool could not be started."));
      });
      child.once("exit", code => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error("Camera media conversion failed."));
      });
    });
  }

  private async probeDuration(mediaPath: string): Promise<number | undefined> {
    return new Promise(resolve => {
      const child = spawn(this.ffprobePath, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", mediaPath], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"]
      });
      let output = "";
      child.stdout.on("data", chunk => { if (output.length < 128) output += String(chunk); });
      const timer = setTimeout(() => child.kill(), 10000);
      child.once("error", () => { clearTimeout(timer); resolve(undefined); });
      child.once("exit", code => {
        clearTimeout(timer);
        const seconds = Number(output.trim());
        resolve(code === 0 && Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined);
      });
    });
  }

  private async captureOnce(candidate: XiaomiMiotMotionClipCandidate): Promise<XiaomiHomeArtifactPublicRecord> {
    const playlistUrl = validateMediaUrl(candidate.playlistUrl, this.allowedHosts);
    const playlist = await this.mediaPlaylist(playlistUrl);
    if (playlist.segments.length > this.maxSegments) throw new Error("Camera clip contains too many HLS segments.");
    const workDir = path.join(this.artifacts.runtimeDir, "capture-work", createHash("sha256").update(candidate.sourceEventId).digest("hex").slice(0, 24));
    fs.mkdirSync(workDir, { recursive: true });
    const keyCache = new Map<string, Buffer>();
    const converted: string[] = [];
    try {
      for (let index = 0; index < playlist.segments.length; index += 1) {
        const segment = playlist.segments[index];
        let bytes = await this.fetchBytes(segment.uri, this.maxSegmentBytes);
        if (segment.key.method === "AES-128") {
          const keyUrl = segment.key.uri.toString();
          let key = keyCache.get(keyUrl);
          if (!key) {
            key = await this.fetchBytes(segment.key.uri, 64);
            if (key.length !== 16) throw new Error("Camera clip HLS key is invalid.");
            keyCache.set(keyUrl, key);
          }
          const decipher = createDecipheriv("aes-128-cbc", key, segment.key.iv ?? sequenceIv(segment.sequence));
          bytes = Buffer.concat([decipher.update(bytes), decipher.final()]);
        }
        const transportPath = path.join(workDir, `segment-${String(index).padStart(4, "0")}.ts`);
        const convertedPath = path.join(workDir, `segment-${String(index).padStart(4, "0")}.mp4`);
        fs.writeFileSync(transportPath, bytes);
        await this.runTool(this.ffmpegPath, ["-loglevel", "error", "-y", "-i", transportPath, "-c", "copy", convertedPath], workDir, 30000);
        converted.push(convertedPath);
      }
      const concatPath = path.join(workDir, "segments.txt");
      fs.writeFileSync(concatPath, converted.map(value => `file '${path.basename(value)}'`).join("\n") + "\n", "utf8");
      const temporaryOutput = path.join(workDir, "output.mp4");
      await this.runTool(this.ffmpegPath, ["-loglevel", "error", "-y", "-f", "concat", "-safe", "1", "-i", concatPath, "-c", "copy", temporaryOutput], workDir, 60000);
      const finalPath = this.artifacts.allocateMediaPath(candidate.sourceEventId, candidate.occurredAt, ".mp4");
      if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
      fs.renameSync(temporaryOutput, finalPath);
      const stat = fs.statSync(finalPath);
      const sha256 = await hashFile(finalPath);
      const durationMs = await this.probeDuration(finalPath);
      return this.artifacts.register({
        sourceEventId: candidate.sourceEventId,
        resourceId: candidate.resourceId,
        eventKind: candidate.eventType || "camera_motion_detected",
        occurredAt: candidate.occurredAt,
        mediaKind: "video/mp4",
        localPath: finalPath,
        sha256,
        byteLength: stat.size,
        durationMs
      });
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
}
