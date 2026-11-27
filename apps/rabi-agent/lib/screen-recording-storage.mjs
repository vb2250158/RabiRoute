
import fs from "node:fs/promises";
import path from "node:path";

export const recordingIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export const recordingMovieName = /^segment-[1-9]\d*-track-[1-9]\d*\.mkv$/;
const dayMs = 86_400_000;
const gib = 1024 ** 3;
export const recordingIsTerminal = job => ["completed", "failed", "cancelled", "expired"].includes(job.state);

export class RecordingStorage {
  constructor(root, policy, now) {
    Object.assign(this, { root, policy, now });
  }

  async atomic(file, value) {
    const temporary = file + ".pending";
    await fs.writeFile(temporary, value);
    await fs.rename(temporary, file);
  }

  async read(id) {
    if (!this.root || !recordingIdPattern.test(id ?? "")) return null;
    const directory = path.join(this.root, id);
    const dir = await fs.lstat(directory).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!dir?.isDirectory() || dir.isSymbolicLink()) return null;
    return fs.readFile(path.join(directory, "status.json"), "utf8").then(text => {
      const receipt = JSON.parse(text);
      return receipt?.recordingId === id ? receipt : null;
    }, error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  }

  write(view) {
    if (!recordingIdPattern.test(view.recordingId)) throw new Error("Invalid recording receipt ID.");
    return this.atomic(path.join(this.root, view.recordingId, "status.json"), JSON.stringify(view));
  }

  expiresAt(receipt, policy = this.policy()) {
    return !receipt.permanent && receipt.finishedAt && policy.retentionDays > 0
      ? receipt.finishedAt + policy.retentionDays * dayMs : null;
  }

  async inventory(protectedIds, clean) {
    const policy = this.policy();
    let cacheBytes = 0, permanentBytes = 0, cleanupPending = 0;
    if (!this.root) return { cacheBytes, permanentBytes, ...policy };
    const directories = await fs.readdir(this.root, { withFileTypes: true }).catch(error => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const dir of directories) {
      if (!dir.isDirectory() || !recordingIdPattern.test(dir.name)) continue;
      const receipt = await this.read(dir.name).catch(error => {
        if (error instanceof SyntaxError) return null;
        throw error;
      });
      const directory = path.join(this.root, dir.name);
      const expiry = receipt && this.expiresAt(receipt, policy);
      const staleInterrupted = receipt && !recordingIsTerminal(receipt) && Number.isSafeInteger(receipt.endAt)
        && policy.retentionDays > 0 && this.now() >= receipt.endAt + Math.max(30_000, policy.retentionDays * dayMs);
      const expired = receipt && (receipt.state === "expired" || expiry != null && this.now() >= expiry || staleInterrupted);
      if (clean && expired && !receipt.permanent && !protectedIds?.includes(dir.name)) {
        // Commit expiry first. If any unlink is interrupted the next pass resumes this same expiry.
        if (receipt.state !== "expired") await this.write({ ...receipt, state: "expired", files: [] });
        for (const name of await fs.readdir(directory)) {
          if (recordingMovieName.test(name)) await fs.unlink(path.join(directory, name)).catch(error => {
            if (error.code !== "ENOENT") cleanupPending++;
          });
        }
      }
      const files = await fs.readdir(directory);
      for (const name of files) {
        if (!recordingMovieName.test(name)) continue;
        const stat = await fs.lstat(path.join(directory, name)).catch(error => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (stat?.isFile()) {
          if (receipt?.permanent) permanentBytes += stat.size;
          else cacheBytes += stat.size;
        }
      }
    }
    return { cacheBytes, permanentBytes, cleanupPending, ...policy };
  }

  async availableBytes(view, tracks, clean = true) {
    const current = await this.inventory([view.recordingId, view.sourceRecordingId], clean);
    const disk = await fs.statfs(this.root);
    const diskBytes = disk.bavail * disk.bsize - 256 * 1024 ** 2;
    const available = view.permanent ? diskBytes : Math.min(diskBytes, current.cacheMaxGiB * gib - current.cacheBytes);
    // Each lossless encoder may write a final packet and container index after its byte limit.
    const perTrack = Math.floor(available / tracks) - 32 * 1024 ** 2;
    if (perTrack < 16 * 1024 ** 2) throw new Error("Recording capacity reached. Save cached videos permanently, change the cache limit, or free disk space.");
    return perTrack;
  }
}
