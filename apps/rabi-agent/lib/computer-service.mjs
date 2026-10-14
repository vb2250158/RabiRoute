import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const CHUNK_BYTES = 65536;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
function absolutePath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) throw new Error("An absolute file path is required.");
  return path.normalize(value);
}
function version(stat) { return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; }
function snapshot(item) { return { uploadId: item.id, path: item.path, size: item.size, sha256: item.sha256, offset: item.offset, state: item.state }; }

/** Computer I/O only. Personas, memory, skills and workflow remain on the controller. */
export class ComputerService {
  constructor({ onChange = () => undefined } = {}) {
    this.uploads = new Map(); this.children = new Set(); this.pending = 0; this.stopped = false; this.onChange = onChange;
  }
  get activeCount() { return this.pending + [...this.uploads.values()].filter(item => item.state === "uploading").length; }
  async execute(input) {
    if (this.stopped) throw new Error("Computer service is stopped.");
    if (this.pending >= 4) throw new Error("Computer I/O is busy; query the existing operation before retrying.");
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
  async upload(input) {
    if (typeof input.uploadId !== "string" || !/^[a-f0-9-]{36}$/.test(input.uploadId)) throw new Error("A stable UUID uploadId is required.");
    let item = this.uploads.get(input.uploadId);
    if (input.action === "upload.begin") {
      const target = absolutePath(input.path);
      if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size > 2147483648 || !/^[a-f0-9]{64}$/.test(input.sha256)) throw new Error("Upload requires size (0..2 GiB) and SHA-256.");
      if (item) {
        if (item.path !== target || item.size !== input.size || item.sha256 !== input.sha256) throw new Error("Upload identity conflicts with existing parameters.");
        return snapshot(item);
      }
      if (this.uploads.size >= 64 || [...this.uploads.values()].filter(entry => entry.state === "uploading").length >= 4) throw new Error("Upload session capacity reached.");
      if (fs.existsSync(target)) throw new Error("Upload destination already exists; select a new path.");
      const temporary = path.join(path.dirname(target), `.rabi-upload-${input.uploadId}.tmp`);
      // Reserve synchronously before any await to prevent duplicate owners.
      const fd = fs.openSync(temporary, "wx", 0o600);
      item = { id: input.uploadId, path: target, temporary, fd, size: input.size, sha256: input.sha256,
        offset: 0, state: "uploading", hash: createHash("sha256"), chunks: new Map() };
      this.uploads.set(item.id, item);
      return snapshot(item);
    }
    if (!item) throw new Error("Upload not found; do not create a new ID after an uncertain write.");
    if (input.action === "upload.status") return snapshot(item);
    if (input.action === "upload.abort") {
      if (item.state === "uploading") { fs.closeSync(item.fd); fs.unlinkSync(item.temporary); item.state = "aborted"; }
      return snapshot(item);
    }
    if (input.action === "upload.commit" && item.state === "committed") return snapshot(item);
    if (item.state !== "uploading") throw new Error("Upload is not writable.");
    if (input.action === "upload.write") {
      if (typeof input.data !== "string" || input.data.length > 87384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data)) throw new Error("A canonical base64 chunk is required.");
      const bytes = Buffer.from(input.data, "base64"); const sha256 = digest(bytes);
      if (!bytes.length || bytes.length > CHUNK_BYTES || sha256 !== input.sha256 || !Number.isSafeInteger(input.offset)) throw new Error("Invalid chunk size, offset or SHA-256.");
      if (input.offset < item.offset) {
        if (item.chunks.get(input.offset) !== `${bytes.length}:${sha256}`) throw new Error("Chunk receipt expired or conflicts.");
        return snapshot(item);
      }
      if (input.offset !== item.offset || item.offset + bytes.length > item.size) throw new Error("Upload offset mismatch; query upload.status.");
      // Bounded synchronous writes keep one upload's offset and receipt atomic.
      let written = 0;
      while (written < bytes.length) written += fs.writeSync(item.fd, bytes, written, bytes.length - written, item.offset + written);
      item.hash.update(bytes); item.chunks.set(item.offset, `${bytes.length}:${sha256}`); item.offset += bytes.length;
      if (item.chunks.size > 256) item.chunks.delete(item.chunks.keys().next().value);
      return snapshot(item);
    }
    if (input.action === "upload.commit") {
      if (item.offset !== item.size) throw new Error("Upload is incomplete.");
      if (item.hash.copy().digest("hex") !== item.sha256) throw new Error("Upload SHA-256 mismatch; abort this upload.");
      fs.fsyncSync(item.fd);
      // Same-directory hard link is atomic and refuses an existing destination.
      fs.linkSync(item.temporary, item.path); item.state = "committed";
      fs.closeSync(item.fd); fs.unlinkSync(item.temporary);
      return snapshot(item);
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
      const deadline = setTimeout(() => child.kill(), 30000);
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
    this.stopped = true;
    for (const child of this.children) child.kill();
    for (const item of this.uploads.values()) if (item.state === "uploading") {
      try { fs.closeSync(item.fd); } catch { }
      try { fs.unlinkSync(item.temporary); } catch { }
      item.state = "aborted";
    }
  }
}
