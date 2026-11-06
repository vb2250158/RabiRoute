import { getTimeoutMs } from "@rabiroute/host-api/shared/timeoutSettings";
import { createDecipheriv, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { ClipToolAvailability } from "./clipToolAvailability.js";
import fs from "node:fs";
import path from "node:path";
import type { XiaomiHomeArtifactPublicRecord } from "./artifactStore.js";
import { XiaomiHomeArtifactStore } from "./artifactStore.js";
import { recordDataMutationAudit } from "@rabiroute/host-api/observability/dataMutationAudit";

export type XiaomiMiotMotionClipCandidate = {
  sourceEventId: string;
  cameraId?: string;
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
  return allowedHosts.length === 0 || allowedHosts.some(pattern => pattern.startsWith("*.")
    ? host.endsWith(pattern.slice(1)) && host !== pattern.slice(2)
    : host === pattern);
}

function validateMediaUrl(value: string | URL, allowedHosts: readonly string[]): URL {
  const url = value instanceof URL ? value : new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Camera media fetch requires an HTTP(S) URL without embedded credentials.");
  if (!hostAllowed(url.hostname, allowedHosts)) throw new Error(`Camera media host ${url.hostname} is not allowed by cameraClipAllowedHosts=${JSON.stringify(allowedHosts)}. Change or clear this list in Xiaomi Home settings.`);
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

/** Proves ownership of an exclusively created output across interruption before registration. */
async function materializeClip(temporaryOutput: string, finalPath: string, runtimeDir: string, ownerRoleId: string | undefined, candidate: XiaomiMiotMotionClipCandidate, digest: string): Promise<{ device: bigint; inode: bigint }> {
  const journalDir = path.join(runtimeDir, "capture-journal");
  await fs.promises.mkdir(journalDir, { recursive: true });
  const directory = await fs.promises.lstat(journalDir);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Unsafe camera capture journal directory.");
  const journalPath = path.join(journalDir, `${createHash("sha256").update(JSON.stringify([ownerRoleId ?? null, candidate.sourceEventId])).digest("hex")}.json`);
  const outputStat = await fs.promises.stat(temporaryOutput, { bigint: true });
  const expected = { version: 1, ownerRoleId: ownerRoleId ?? null, sourceEventId: candidate.sourceEventId,
    cameraId: candidate.cameraId ?? null, resourceId: candidate.resourceId, occurredAt: candidate.occurredAt,
    eventType: candidate.eventType, target: finalPath, sha256: digest, byteLength: outputStat.size.toString() };
  let targetFile: fs.promises.FileHandle | undefined;
  try {
    if (fs.existsSync(journalPath)) {
      const journalStat = await fs.promises.lstat(journalPath);
      if (!journalStat.isFile() || journalStat.isSymbolicLink() || journalStat.size > 16384) throw new Error("Unsafe camera capture journal.");
      const journal = JSON.parse(await fs.promises.readFile(journalPath, "utf8"));
      if (Object.entries(expected).some(([key, value]) => journal[key] !== value)
        || typeof journal.device !== "string" || typeof journal.inode !== "string" || journal.inode === "0") {
        throw new Error("Camera capture journal does not match this event.");
      }
      const before = await fs.promises.lstat(finalPath, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink()) throw new Error("Unsafe existing camera clip.");
      targetFile = await fs.promises.open(finalPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const actual = await targetFile.stat({ bigint: true });
      if (actual.dev.toString() !== journal.device || actual.ino.toString() !== journal.inode
        || before.dev !== actual.dev || before.ino !== actual.ino || actual.size !== outputStat.size) {
        throw new Error("Existing camera clip is not the journaled complete file.");
      }
      const actualHash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      for (;;) {
        const { bytesRead } = await targetFile.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        actualHash.update(buffer.subarray(0, bytesRead));
      }
      if (actualHash.digest("hex") !== digest) throw new Error("Existing camera clip content does not match the journal.");
      return { device: actual.dev, inode: actual.ino };
    }
    targetFile = await fs.promises.open(finalPath, "wx");
    const target = await targetFile.stat({ bigint: true });
    const journalFile = await fs.promises.open(journalPath, "wx");
    try {
      await journalFile.writeFile(JSON.stringify({ ...expected, device: target.dev.toString(), inode: target.ino.toString() }));
      await journalFile.sync();
    } finally { await journalFile.close(); }
    const inputFile = await fs.promises.open(temporaryOutput, "r");
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      for (;;) {
        const { bytesRead } = await inputFile.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        let written = 0;
        while (written < bytesRead) {
          const result = await targetFile.write(buffer, written, bytesRead - written);
          if (!result.bytesWritten) throw new Error("Camera clip write made no progress.");
          written += result.bytesWritten;
        }
      }
      await targetFile.sync();
    } finally { await inputFile.close(); }
    return { device: target.dev, inode: target.ino };
  } finally { await targetFile?.close(); }
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
  private readonly ffmpegAvailability: ClipToolAvailability;
  private readonly requestTimeoutMs: number;
  private readonly maxSegments: number;
  private readonly maxSegmentBytes: number;
  private readonly inFlight = new Map<string, Promise<XiaomiHomeArtifactPublicRecord>>();
  private stopped = false;

  constructor(
    config: XiaomiHomeClipCaptureConfig,
    private readonly artifacts: XiaomiHomeArtifactStore,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly roleDirectory?: () => string,
    private readonly ownerRoleId?: string
  ) {
    this.enabled = config.cameraClipCaptureEnabled === true;
    this.allowedHosts = normalizedAllowedHosts(config.cameraClipAllowedHosts);
    this.ffmpegPath = safeToolPath(config.ffmpegPath, "ffmpeg");
    this.ffmpegAvailability = new ClipToolAvailability(this.ffmpegPath);
    this.ffprobePath = safeToolPath(config.ffprobePath, "ffprobe");
    this.requestTimeoutMs = getTimeoutMs("backend.integrations.xiaomiHome.clipCapture.owner.Number.cameraClipRequestTimeoutMs", Math.min(30000, Math.max(1000, Number(config.cameraClipRequestTimeoutMs ?? 10000))));
    this.maxSegments = Math.min(500, Math.max(1, Number(config.cameraClipMaxSegments ?? 120)));
    this.maxSegmentBytes = Math.min(128 * 1024 * 1024, Math.max(1024, Number(config.cameraClipMaxSegmentBytes ?? 32 * 1024 * 1024)));
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  start(): void {
    if (this.enabled && !this.stopped) void this.ffmpegAvailability.start();
  }

  status(): Record<string, unknown> {
    return {
      enabled: this.enabled,
      ready: this.enabled && this.ffmpegAvailability.status() === "ready",
      ffmpegStatus: this.ffmpegAvailability.status(),
      allowedHostCount: this.allowedHosts.length,
      inFlight: this.inFlight.size
    };
  }

  capture(candidate: XiaomiMiotMotionClipCandidate): Promise<XiaomiHomeArtifactPublicRecord> {
    if (this.stopped) return Promise.reject(new Error('Camera clip owner has stopped.'));
    if (!this.isEnabled()) return Promise.reject(new Error("cameraClipCaptureEnabled=false. Enable camera clip capture in Xiaomi Home settings."));
    if (this.ffmpegAvailability.status() === "unavailable") this.start();
    const captured = this.artifacts.getBySourceEventId(candidate.sourceEventId, this.ownerRoleId);
    if (captured) return Promise.resolve(captured);
    const existing = this.inFlight.get(candidate.sourceEventId);
    if (existing) return existing;
    const operation = this.captureOnce(candidate).finally(() => this.inFlight.delete(candidate.sourceEventId));
    this.inFlight.set(candidate.sourceEventId, operation);
    return operation;
  }

  /** No new capture is admitted; accepted native fetches/tools are joined, never detached. */
  async close(): Promise<void> {
    this.stopped = true;
    await Promise.all([this.ffmpegAvailability.close(), Promise.allSettled(this.inFlight.values())]);
  }

  private async fetchMedia(url: URL, maxBytes: number, redirects = 0): Promise<{ bytes: Buffer; url: URL }> {
    validateMediaUrl(url, this.allowedHosts);
    const response = await this.fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(this.requestTimeoutMs) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects >= 4) throw new Error("Camera media returned too many redirects.");
      const location = response.headers.get("location");
      if (!location) throw new Error("Camera media redirect has no target.");
      await response.body?.cancel();
      return this.fetchMedia(validateMediaUrl(new URL(location, url), this.allowedHosts), maxBytes, redirects + 1);
    }
    if (!response.ok) throw new Error(`Camera media request failed with HTTP ${response.status}.`);
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new Error("Camera media response exceeds the configured size limit.");
    }
    if (!response.body) return { bytes: Buffer.alloc(0), url };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new Error("Camera media response exceeds the configured size limit.");
        chunks.push(value);
      }
      return { bytes: Buffer.concat(chunks, size), url };
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  private async fetchBytes(url: URL, maxBytes: number): Promise<Buffer> {
    return (await this.fetchMedia(url, maxBytes)).bytes;
  }

  private async mediaPlaylist(initial: URL): Promise<{ url: URL; segments: HlsSegment[] }> {
    const first = await this.fetchMedia(initial, 1024 * 1024);
    const firstText = first.bytes.toString("utf8");
    const lines = firstText.replace(/\r/g, "").split("\n").map(line => line.trim()).filter(Boolean);
    const masterIndex = lines.findIndex(line => line.startsWith("#EXT-X-STREAM-INF:"));
    if (masterIndex >= 0) {
      const variant = lines.slice(masterIndex + 1).find(line => !line.startsWith("#"));
      if (!variant) throw new Error("Camera clip master playlist has no media variant.");
      const variantUrl = validateMediaUrl(new URL(variant, first.url), this.allowedHosts);
      const media = await this.fetchMedia(variantUrl, 1024 * 1024);
      return { url: media.url, segments: parseHlsMediaPlaylist(media.bytes.toString("utf8"), media.url, this.allowedHosts) };
    }
    return { url: first.url, segments: parseHlsMediaPlaylist(firstText, first.url, this.allowedHosts) };
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
      const timer = setTimeout(() => child.kill(), getTimeoutMs("deadline.integrations.xiaomiHome.clipCapture.probeDuration", 10000));
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
    let allocatedPath: string | undefined;
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
      const finalPath = this.roleDirectory
        ? this.artifacts.allocateCameraPath(this.roleDirectory(), {
          eventId: candidate.sourceEventId, cameraId: candidate.cameraId ?? candidate.resourceId,
          occurredAt: candidate.occurredAt, adapterId: "xiaomi-miot", kind: candidate.eventType, resourceId: candidate.resourceId
        })
        : this.artifacts.allocateMediaPath(candidate.sourceEventId, candidate.occurredAt, ".mp4");
      allocatedPath = finalPath;
      const expectedDigest = await hashFile(temporaryOutput);
      let identity: { device: bigint; inode: bigint };
      try {
        identity = await materializeClip(temporaryOutput, finalPath, this.artifacts.runtimeDir, this.ownerRoleId, candidate, expectedDigest);
      } catch (error) {
        recordDataMutationAudit({
          level: "error",
          group: "media",
          event: "xiaomi_camera_clip_write_failed",
          owner: "xiaomi-home-clip-capture",
          action: "materialize-camera-clip",
          target: { type: "xiaomi-home-artifact", id: candidate.sourceEventId },
          dataSource: { kind: "file", id: `xiaomi-home-artifacts/${path.basename(finalPath)}` },
          outcome: "failed",
          error
        });
        throw error;
      }
      const stat = fs.statSync(finalPath);
      const sha256 = await hashFile(finalPath);
      const checked = await fs.promises.lstat(finalPath, { bigint: true });
      if (!checked.isFile() || checked.isSymbolicLink() || checked.dev !== identity.device || checked.ino !== identity.inode
        || checked.size !== BigInt(stat.size) || sha256 !== expectedDigest) throw new Error("Camera clip changed before artifact registration.");
      recordDataMutationAudit({
        group: "media",
        event: "xiaomi_camera_clip_written",
        owner: "xiaomi-home-clip-capture",
        action: "materialize-camera-clip",
        target: { type: "xiaomi-home-artifact", id: candidate.sourceEventId },
        dataSource: { kind: "file", id: `xiaomi-home-artifacts/${path.basename(finalPath)}` },
        outcome: "committed",
        result: `byteLength=${stat.size};sha256=${sha256}`
      });
      const durationMs = await this.probeDuration(finalPath);
      return this.artifacts.register({
        sourceEventId: candidate.sourceEventId,
        ownerRoleId: this.ownerRoleId,
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
      if (allocatedPath) this.artifacts.releaseCameraPath(allocatedPath);
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
}
