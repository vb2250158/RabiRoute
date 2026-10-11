import { promises as fs } from "node:fs";
import path from "node:path";

/** Reduced-frame attachment lease. Only this generation's own files are removed. */
export class CompanionFrameDelivery {
  private directory?: Promise<string>;
  private files = new Map<string, { path: string; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly localRoot: string) {}
  async stage(reviewId: string, bytes: Buffer, expiresAt: number): Promise<string> {
    if (!/^[a-f0-9-]{36}$/.test(reviewId) || bytes.length > 2 * 1024 * 1024 || expiresAt <= Date.now()) throw new Error("Invalid companion attachment lease");
    const old = this.files.get(reviewId); if (old) return old.path;
    if (!this.directory) this.directory = fs.realpath(this.localRoot).then(root => {
      if (/^(?:\\\\|\/\/)/.test(root)) throw new Error("Companion attachments require local storage");
      return fs.mkdtemp(path.join(root, ".companion-frame-"));
    });
    const file = path.join(await this.directory, `${reviewId}.jpg`);
    await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 });
    const timer = setTimeout(() => { void this.remove(reviewId).catch(() => undefined); }, Math.max(1, expiresAt - Date.now()));
    timer.unref?.(); this.files.set(reviewId, { path: file, timer });
    await this.retain(reviewId); return file;
  }
  private async remove(reviewId: string) {
    const entry = this.files.get(reviewId); if (!entry) return;
    this.files.delete(reviewId); clearTimeout(entry.timer); await fs.unlink(entry.path).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
  async retain(reviewId?: string) { await Promise.all([...this.files.keys()].filter(id => id !== reviewId).map(id => this.remove(id))); }
  async dispose() { await this.retain(); if (this.directory) await fs.rmdir(await this.directory); }
}
