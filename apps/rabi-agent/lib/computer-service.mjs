import { UploadHistoryStore } from "./upload-history-store.mjs";
import { COMPUTER_LIMITS } from "./interactive-protocol.mjs";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const CHUNK_BYTES = COMPUTER_LIMITS.chunkBytes;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
function absolutePath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) throw new Error("An absolute file path is required.");
  return path.normalize(value);
}
function version(stat) { return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; }
function snapshot(item) { return { uploadId: item.id, path: item.path, size: item.size, sha256: item.sha256, offset: item.offset, state: item.state }; }
function configuredLimit(name, fallback) { return process.env[name] === undefined ? fallback : Number(process.env[name]); }
function capacityError(name, value) { return new Error(`Computer resource limit reached: ${name}=${value}. Adjust this environment variable in the remote Rabi Agent launcher and restart that Agent to apply it. Query the original operation before retrying.`); }

/** Computer I/O only. Personas, memory, skills and workflow remain on the controller. */
export class ComputerService {
  constructor({ onChange = () => undefined, uploadHistoryRoot, historyIo, timeout = (_key, fallback) => fallback,
    maxUploadBytes = configuredLimit("RABI_AGENT_COMPUTER_MAX_UPLOAD_BYTES", Number.MAX_SAFE_INTEGER),
    maxConcurrentIo = configuredLimit("RABI_AGENT_COMPUTER_MAX_CONCURRENT_IO", 4),
    maxActiveUploads = configuredLimit("RABI_AGENT_COMPUTER_MAX_ACTIVE_UPLOADS", 4),
    maxUploadRecords = configuredLimit("RABI_AGENT_COMPUTER_MAX_UPLOAD_RECORDS", 64) } = {}) {
    for (const [name, value] of Object.entries({ MAX_UPLOAD_BYTES: maxUploadBytes, MAX_CONCURRENT_IO: maxConcurrentIo, MAX_ACTIVE_UPLOADS: maxActiveUploads, MAX_UPLOAD_RECORDS: maxUploadRecords })) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`RABI_AGENT_COMPUTER_${name} must be a non-negative exact byte count or resource count.`);
    }
    Object.assign(this, { maxUploadBytes, maxConcurrentIo, maxActiveUploads, maxUploadRecords });
    this.timeout = timeout;
    this.uploads = new Map(); this.uploadQueues = new Map(); this.history = new UploadHistoryStore({ root: uploadHistoryRoot, io: historyIo });
    this.children = new Set(); this.pending = 0; this.stopped = false; this.onChange = onChange; this.stopOwner = null;
  }
  get activeCount() { return this.pending + this.activeUploads(); }
  activeUploads() { return [...this.uploads.values()].filter(item => !this.terminalClosed(item)).length + this.history.openHandleCount; }
  terminalClosed(item) { return ["committed", "aborted"].includes(item.state) && item.fdClosed === true && item.temporaryRemoved === true && Number.isSafeInteger(item.confirmedAt); }
  async execute(input) {
    if (this.stopped) throw new Error("Computer service is stopped.");
    if (this.maxConcurrentIo > 0 && this.pending >= this.maxConcurrentIo) throw capacityError("RABI_AGENT_COMPUTER_MAX_CONCURRENT_IO", this.maxConcurrentIo);
    this.pending++; this.onChange();
    try {
      if (input.action === "file.stat" || input.action === "file.read") return await this.readFile(input);
      if (String(input.action).startsWith("upload.")) return await this.upload(input);
      if (["windows.list", "screen.capture"].includes(input.action)) return await this.desktop(input);
      throw new Error("Unsupported computer operation.");
    } finally { this.pending--; this.onChange(); }
  }
  async readFile(input) {
    const target = absolutePath(input.path);
    const file = await fs.promises.open(target, "r");
    try {
      const before = await file.stat();
      if (!before.isFile()) throw new Error("The path is not a regular file.");
      const currentVersion = version(before);
      if (input.action === "file.stat") return { path: target, size: before.size, version: currentVersion, chunkBytes: CHUNK_BYTES };
      if (input.version !== currentVersion) throw new Error("The file changed; restart the download using a fresh file.stat result.");
      if (!Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset > before.size) throw new Error("Invalid file offset.");
      const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, before.size - input.offset));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, input.offset);
      if (version(await file.stat()) !== currentVersion) throw new Error("The file changed while reading.");
      const bytes = buffer.subarray(0, bytesRead);
      return { path: target, version: currentVersion, offset: input.offset, nextOffset: input.offset + bytesRead,
        size: before.size, eof: input.offset + bytesRead === before.size, data: bytes.toString("base64"), sha256: digest(bytes) };
    } finally { await file.close(); }
  }
  upload(input) {
    if (typeof input.uploadId !== "string" || !new RegExp(COMPUTER_LIMITS.uploadIdPattern).test(input.uploadId)) throw new Error("A stable UUID uploadId is required.");
    const previous = this.uploadQueues.get(input.uploadId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => this.uploadOwned(input));
    this.uploadQueues.set(input.uploadId, current);
    const release = () => { if (this.uploadQueues.get(input.uploadId) === current) this.uploadQueues.delete(input.uploadId); };
    void current.then(release, release);
    return current;
  }
  async persistTerminal(item) {
    if (!this.terminalClosed(item)) throw item.cleanupError ?? new Error("Upload cleanup remains unconfirmed; keep the original ID.");
    if (!item.archived) {
      await this.history.save(snapshot(item), item.confirmedAt);
      item.archived = true;
    }
  }
  closeUpload(item, state) {
    if (item.cleanupError) throw item.cleanupError;
    try {
      if (!item.fdClosed) { fs.closeSync(item.fd); item.fdClosed = true; item.fd = undefined; }
      if (!item.temporaryRemoved) { fs.unlinkSync(item.temporary); item.temporaryRemoved = true; }
      item.state = state; item.confirmedAt ??= Date.now();
      item.hash = undefined; item.chunks = undefined;
    } catch (error) { item.cleanupError = error; throw error; }
  }
  async uploadOwned(input) {
    if (this.stopped) throw new Error("Computer service is stopped.");
    let target;
    if (input.action === "upload.begin") {
      target = absolutePath(input.path);
      if (!Number.isSafeInteger(input.size) || input.size < 0 || !new RegExp(COMPUTER_LIMITS.hashPattern).test(input.sha256)) throw new Error("Upload requires a non-negative exact byte count and SHA-256.");
    }
    let item = this.uploads.get(input.uploadId);
    if (!item) {
      const cold = await this.history.read(input.uploadId);
      if (this.stopped) throw new Error("Computer service is stopped.");
      if (cold) {
        const original = cold.upload;
        if (input.action === "upload.begin") {
          if (original.path !== target || original.size !== input.size || original.sha256 !== input.sha256) throw new Error("Upload identity conflicts with existing parameters.");
          return original;
        }
        if (input.action === "upload.status" || input.action === "upload.abort" || input.action === "upload.commit" && original.state === "committed") return original;
        throw new Error("Upload is not writable.");
      }
    }
    if (input.action === "upload.begin") {
      if (item) {
        if (item.path !== target || item.size !== input.size || item.sha256 !== input.sha256) throw new Error("Upload identity conflicts with existing parameters.");
        return snapshot(item);
      }
      if (input.size > this.maxUploadBytes) throw new Error(`Upload exceeds RABI_AGENT_COMPUTER_MAX_UPLOAD_BYTES=${this.maxUploadBytes}. Adjust this environment variable in the remote Rabi Agent launcher and restart that Agent to apply it.`);
      for (;;) {
        if (this.stopped) throw new Error("Computer service is stopped.");
        if (this.maxActiveUploads > 0 && this.activeUploads() >= this.maxActiveUploads) throw capacityError("RABI_AGENT_COMPUTER_MAX_ACTIVE_UPLOADS", this.maxActiveUploads);
        if (this.maxUploadRecords === 0 || this.uploads.size < this.maxUploadRecords) break;
        // Count pressure overrides age windows: only cold-confirmed closed terminal facts may leave heat.
        const closed = [...this.uploads.values()].filter(value => this.terminalClosed(value));
        const terminal = closed.find(value => value.archived) ?? closed[0];
        if (!terminal) throw new Error("Upload session capacity reached; unresolved original owners are retained.");
        await this.persistTerminal(terminal);
        if (this.uploads.get(terminal.id) === terminal && terminal.archived) this.uploads.delete(terminal.id);
      }
      if (fs.existsSync(target)) throw new Error("Upload destination already exists; select a new path.");
      const temporary = path.join(path.dirname(target), ".rabi-upload-" + input.uploadId + ".tmp");
      // No await between capacity recheck, real fd reservation and registration.
      const fd = fs.openSync(temporary, "wx", 0o600);
      item = { id: input.uploadId, path: target, temporary, fd, size: input.size, sha256: input.sha256,
        offset: 0, state: "uploading", hash: createHash("sha256"), chunks: new Map(),
        fdClosed: false, temporaryRemoved: false, archived: false };
      this.uploads.set(item.id, item);
      return snapshot(item);
    }
    if (!item) throw new Error("Upload not found; do not create a new ID after an uncertain write.");
    if (input.action === "upload.status") return snapshot(item);
    if (input.action === "upload.abort") {
      if (item.state === "uploading") { item.intent = "aborted"; this.closeUpload(item, "aborted"); }
      await this.persistTerminal(item); return snapshot(item);
    }
    if (input.action === "upload.commit" && item.state === "committed") { await this.persistTerminal(item); return snapshot(item); }
    if (item.state !== "uploading" || item.intent || item.fdClosed || item.cleanupError) throw new Error("Upload is not writable; query its original status.");
    if (input.action === "upload.write") {
      if (typeof input.data !== "string" || input.data.length > COMPUTER_LIMITS.chunkBase64CodeUnits || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data)) throw new Error("A canonical base64 chunk is required.");
      const bytes = Buffer.from(input.data, "base64"); const sha256 = digest(bytes);
      if (!bytes.length || bytes.length > CHUNK_BYTES || sha256 !== input.sha256 || !Number.isSafeInteger(input.offset)) throw new Error("Invalid chunk size, offset or SHA-256.");
      if (input.offset < item.offset) {
        if (item.chunks.get(input.offset) !== bytes.length + ":" + sha256) throw new Error("Chunk receipt expired or conflicts.");
        return snapshot(item);
      }
      if (input.offset !== item.offset || item.offset + bytes.length > item.size) throw new Error("Upload offset mismatch; query upload.status.");
      let written = 0;
      while (written < bytes.length) written += fs.writeSync(item.fd, bytes, written, bytes.length - written, item.offset + written);
      item.hash.update(bytes); item.chunks.set(item.offset, bytes.length + ":" + sha256); item.offset += bytes.length;
      if (item.chunks.size > 256) item.chunks.delete(item.chunks.keys().next().value);
      return snapshot(item);
    }
    if (input.action === "upload.commit") {
      if (item.offset !== item.size) throw new Error("Upload is incomplete.");
      if (item.hash.copy().digest("hex") !== item.sha256) throw new Error("Upload SHA-256 mismatch; abort this upload.");
      fs.fsyncSync(item.fd);
      fs.linkSync(item.temporary, item.path); item.state = "committed"; item.intent = "committed";
      this.closeUpload(item, "committed");
      await this.persistTerminal(item); return snapshot(item);
    }
    throw new Error("Unsupported upload operation.");
  }
  desktop(input) {
    if (process.platform !== "win32") throw new Error("Window queries and screenshots require Windows.");
    return new Promise((resolve, reject) => {
      const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
      const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL("../desktop/computer.ps1", import.meta.url))], {
        windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(RABI_|RABIROUTE_|CODEX_)/i.test(key)))
      });
      this.children.add(child); let output = "";
      const deadline = setTimeout(() => child.kill(), this.timeout("agent.computer.process", 30000));
      child.stdout.setEncoding("utf8"); child.stdout.on("data", data => { output += data; if (output.length > 12000000) child.kill(); });
      child.stderr.resume(); child.stdin.on("error", () => undefined);
      child.once("error", () => reject(new Error("Desktop helper could not start.")));
      child.once("close", code => {
        clearTimeout(deadline); this.children.delete(child);
        try {
          if (code !== 0) throw new Error("Desktop capture failed or timed out; an interactive Windows desktop is required.");
          const result = JSON.parse(output);
          if (result.error) throw new Error(result.error);
          resolve(result);
        } catch (error) { reject(error); }
      });
      child.stdin.write(`${JSON.stringify(input)}\n`);
    });
  }
  stop() {
    if (this.stopOwner) return this.stopOwner;
    this.stopped = true;
    for (const child of this.children) child.kill();
    const failures = [];
    for (const item of this.uploads.values()) if (item.state === "uploading") {
      item.intent = "aborted";
      try { this.closeUpload(item, "aborted"); } catch (error) { failures.push(error); }
    }
    // The upload cleanup owner retains pending cold I/O; stopping is not proof that any fd closed.
    this.stopOwner = Promise.allSettled([...this.uploadQueues.values()]).then(async () => {
      for (const item of this.uploads.values()) {
        if (this.terminalClosed(item)) {
          try { await this.persistTerminal(item); } catch (error) { failures.push(error); }
        } else if (item.cleanupError && !failures.includes(item.cleanupError)) failures.push(item.cleanupError);
      }
      if (this.history.openHandleCount) failures.push(new Error("Upload history handle close remains unconfirmed."));
      if (failures.length) throw new AggregateError(failures, "Upload cleanup remains unconfirmed; original IDs and owners are retained.");
    });
    return this.stopOwner;
  }
}
