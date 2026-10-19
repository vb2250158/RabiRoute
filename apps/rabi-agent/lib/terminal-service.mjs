import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const terminalId = value => {
  if (typeof value !== "string" || !/^[a-f0-9-]{36}$/.test(value)) throw new Error("Invalid terminal ID.");
  return value;
};
export class TerminalService {
  constructor({ emit, defaultCwd = os.homedir(), onChange = () => undefined }) {
    this.emit = emit; this.defaultCwd = defaultCwd; this.onChange = onChange;
    this.sessions = new Map(); this.stopped = false;
  }
  get activeCount() { return [...this.sessions.values()].filter(item => item.state !== "exited").length; }
  get shells() { return process.platform === "win32" ? ["cmd", "powershell"] : ["zsh", "bash", "sh"].filter(shell => fs.existsSync(`/bin/${shell}`)); }
  snapshot(item) {
    return { terminalId: item.id, shell: item.shell, cwd: item.cwd, state: item.state, pid: item.pid,
      createdAt: item.createdAt, nextInputSequence: item.nextInputSequence, exitCode: item.exitCode };
  }
  async execute(input) {
    if (this.stopped) throw new Error("The main program is stopping.");
    if (input.action === "list") return { shells: this.shells, sessions: [...this.sessions.values()].map(item => this.snapshot(item)) };
    const id = terminalId(input.terminalId);
    let item = this.sessions.get(id);
    if (input.action === "open") {
      if (!this.shells.includes(input.shell)) throw new Error("Choose a shell advertised by this computer.");
      const cwd = input.cwd || this.defaultCwd;
      if (typeof cwd !== "string" || !path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error("Working directory must be an existing absolute directory on the remote computer.");
      const canonical = fs.realpathSync(cwd);
      if (item) {
        if (item.shell !== input.shell || item.cwd !== canonical) throw new Error("Terminal identity conflict; the existing session is unchanged.");
        await item.ready; return this.snapshot(item);
      }
      if (this.activeCount >= 8) throw new Error("This node already has eight active terminals.");
      // Retain a bounded set of closed-session tombstones to reject accidental reuse.
      if (this.sessions.size >= 64) throw new Error("Terminal history is full; restart the connector after closing its sessions.");
      item = { id, shell: input.shell, cwd: canonical, state: "starting", createdAt: new Date().toISOString(), nextInputSequence: 1, inputs: new Map() };
      this.sessions.set(id, item);
      this.start(item); await item.ready; return this.snapshot(item);
    }
    if (!item) throw new Error("Terminal not found; query the current session list.");
    if (input.action === "get") return this.snapshot(item);
    if (input.action === "close") { await this.close(item); return this.snapshot(item); }
    if (item.state !== "running") throw new Error("Terminal is not running.");
    if (input.action === "input") {
      if (!Number.isSafeInteger(input.sequence) || input.sequence < 1 || typeof input.data !== "string" || Buffer.byteLength(input.data) > 16384) throw new Error("Input requires a sequence and at most 16 KiB of text.");
      const digest = createHash("sha256").update(input.data).digest("hex");
      if (input.sequence < item.nextInputSequence) {
        if (item.inputs.get(input.sequence) !== digest) throw new Error("Input receipt expired or conflicts; do not replay it.");
        return this.snapshot(item);
      }
      if (input.sequence !== item.nextInputSequence) throw new Error("Input sequence mismatch; query the terminal before continuing.");
      // Reserve before writing. A pipe error is uncertain and is never replayed.
      item.inputs.set(input.sequence, digest); item.nextInputSequence++;
      if (item.inputs.size > 256) item.inputs.delete(item.inputs.keys().next().value);
      this.write(item, { action: "input", data: input.data });
      return this.snapshot(item);
    }
    if (input.action === "resize") {
      if (!Number.isInteger(input.cols) || !Number.isInteger(input.rows) || input.cols < 20 || input.cols > 400 || input.rows < 5 || input.rows > 200) throw new Error("Invalid terminal dimensions.");
      this.write(item, { action: "resize", cols: input.cols, rows: input.rows });
      return this.snapshot(item);
    }
    throw new Error("Unsupported terminal operation.");
  }
  write(item, value) {
    if (!item.child?.stdin.writable || item.child.stdin.writableLength > 65536) throw new Error("Terminal input is unavailable or backpressured; query before continuing.");
    item.child.stdin.write(`${JSON.stringify(value)}\n`);
  }
  start(item) {
    const windows = process.platform === "win32";
    const script = fileURLToPath(new URL(windows ? "../terminal/host.ps1" : "../terminal/posix-host.mjs", import.meta.url));
    const executable = windows ? path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe") : process.execPath;
    const child = spawn(executable, windows ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script] : [script], {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(RABI_|RABIROUTE_|CODEX_)/i.test(key)))
    });
    item.child = child;
    child.stdout.setEncoding("utf8"); child.stderr.resume(); child.stdin.on("error", () => undefined);
    let buffer = "";
    let resolveReady; let rejectReady;
    item.ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const deadline = setTimeout(() => { rejectReady(new Error("Native terminal startup timed out.")); child.kill(); }, 30000);
    const publish = event => this.emit({ terminalId: item.id, ...event });
    child.stdout.on("data", data => {
      buffer += data;
      if (buffer.length > 131072) { child.kill(); return; }
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        let event;
        try { event = JSON.parse(buffer.slice(0, end)); } catch { buffer = buffer.slice(end + 1); continue; }
        buffer = buffer.slice(end + 1);
        if (event.type === "ready") { item.state = "running"; item.pid = event.pid; clearTimeout(deadline); resolveReady(); this.onChange(); }
        if (event.type === "error") { rejectReady(new Error(event.message || "Terminal host failed.")); child.stdin.end(); }
        if (event.type === "output" && typeof event.data === "string") publish({ type: "output", data: event.data.slice(0, 16384) });
        if (event.type === "exit") { item.exitCode = event.code; child.stdin.end(); }
      }
    });
    item.closed = new Promise(resolve => child.once("close", code => {
      clearTimeout(deadline); rejectReady(new Error("Native terminal startup failed."));
      item.state = "exited"; item.exitCode ??= code;
      publish({ type: "exit", exitCode: item.exitCode }); this.onChange(); resolve();
    }));
    child.once("error", () => rejectReady(new Error("Native terminal host could not start.")));
    this.write(item, { action: "open", shell: item.shell, cwd: item.cwd });
  }
  close(item) {
    if (item.state === "exited") return;
    if (item.closePromise) return item.closePromise;
    item.state = "closing"; this.onChange();
    item.closePromise = (async () => {
      item.child.stdin.end(); // Native host closes its Job Object, including descendants.
      const deadline = setTimeout(() => item.child.kill(), 3000);
      try { await item.closed; } finally { clearTimeout(deadline); }
    })();
    return item.closePromise;
  }
  closeAll() { return Promise.all([...this.sessions.values()].map(item => this.close(item))); }
  stop() { this.stopped = true; return this.closeAll(); }
}
