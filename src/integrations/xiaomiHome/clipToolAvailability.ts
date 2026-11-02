import { spawn } from "node:child_process";

export type ClipToolStatus = "idle" | "checking" | "ready" | "unavailable" | "stopped";
type Probe = (executable: string, signal: AbortSignal, timeoutMs: number) => Promise<boolean>;

/** Run the configured binary itself: a PATH lookup cannot establish executability. */
export function probeFfmpeg(executable: string, signal: AbortSignal, timeoutMs: number): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(executable, ["-version"], { shell: false, windowsHide: true, stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }
    let timedOut = false;
    const cancel = () => { timedOut = true; child.kill(); };
    const timer = setTimeout(cancel, timeoutMs);
    signal.addEventListener("abort", cancel, { once: true });
    const finish = (success: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      resolve(success && !timedOut && !signal.aborted);
    };
    child.once("error", () => finish(false));
    child.once("exit", code => finish(code === 0));
  });
}

/** Owned by one capture worker; status is a cached observation, not persistent configuration. */
export class ClipToolAvailability {
  private value: ClipToolStatus = "idle";
  private readonly abort = new AbortController();
  private pending?: Promise<void>;

  constructor(private readonly executable: string, private readonly options: {
    timeoutMs?: number; retryDelayMs?: number; attempts?: number; probe?: Probe;
  } = {}) {}

  status(): ClipToolStatus { return this.value; }

  start(): Promise<void> {
    if (this.abort.signal.aborted || this.value === "ready") return Promise.resolve();
    if (this.pending) return this.pending;
    this.value = "checking";
    this.pending = this.check().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async check(): Promise<void> {
    const attempts = Math.max(1, Math.min(5, Math.floor(this.options.attempts ?? 3)));
    for (let attempt = 0; attempt < attempts && !this.abort.signal.aborted; attempt++) {
      let ok = false;
      try { ok = await (this.options.probe ?? probeFfmpeg)(this.executable, this.abort.signal, this.options.timeoutMs ?? 5000); }
      catch { /* Spawn and platform errors are unavailable, not readiness. */ }
      if (this.abort.signal.aborted) return;
      if (ok) { this.value = "ready"; return; }
      if (attempt + 1 < attempts) await this.waitRetry();
    }
    if (!this.abort.signal.aborted) this.value = "unavailable";
  }

  private waitRetry(): Promise<void> {
    return new Promise(resolve => {
      const signal = this.abort.signal;
      const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, this.options.retryDelayMs ?? 1000);
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
  }

  async close(): Promise<void> {
    this.abort.abort();
    this.value = "stopped";
    await this.pending;
  }
}
