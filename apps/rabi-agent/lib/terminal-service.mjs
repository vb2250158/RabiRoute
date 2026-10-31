import { TERMINAL_LIMITS } from "./interactive-protocol.mjs";
import fs from "node:fs";
import { TerminalHistory } from "./terminal-history.mjs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const terminalId = value => {
  if (typeof value !== "string" || !new RegExp(TERMINAL_LIMITS.idPattern).test(value)) throw new Error("Invalid terminal ID.");
  return value;
};
export class TerminalService {
  constructor({ emit, timeout = (_key, fallback) => fallback, defaultCwd = os.homedir(), onChange = () => undefined, historyDirectory }) {
    this.timeout = timeout;
    this.emit = emit; this.defaultCwd = defaultCwd; this.onChange = onChange;
    this.sessions = new Map(); this.stopped = false;
    this.history = new TerminalHistory(historyDirectory);
    this.openAdmission = Promise.resolve(); this.pendingOpens = 0;
    this.historyDiagnostics = [];
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
    if (input.action === "open") {
      if (this.pendingOpens >= TERMINAL_LIMITS.retainedSessions) throw Object.assign(new Error("Terminal creation queue is full; query before retrying."), { code: "TERMINAL_OPEN_NOT_STARTED" });
      this.pendingOpens++;
      const admission = this.openAdmission.then(() => this.admitOpen(id, input));
      this.openAdmission = admission.then(() => undefined, () => undefined);
      let admitted;
      try { admitted = await admission; }
      catch (error) {
        // Admission is before native start. Once a session has been reserved,
        // preserve uncertainty instead of claiming that nothing happened.
        if (!this.sessions.has(id)) error.code = "TERMINAL_OPEN_NOT_STARTED";
        throw error;
      } finally { this.pendingOpens--; }
      if (admitted.archived) {
        if (admitted.archived.startError) throw new Error(admitted.archived.startError);
        return admitted.archived.terminal;
      }
      await admitted.item.ready; return this.snapshot(admitted.item);
    }
    let item = this.sessions.get(id);
    if (!item) {
      const archived = await this.history.read(id);
      if (archived && ["get", "close"].includes(input.action)) return archived.terminal;
      if (archived) throw new Error("Terminal is not running.");
    }
    if (!item) throw new Error("Terminal not found; query the current session list.");
    if (input.action === "get") return this.snapshot(item);
    if (input.action === "close") { await this.close(item); return this.snapshot(item); }
    if (item.state !== "running") throw new Error("Terminal is not running.");
    if (input.action === "input") {
      if (!Number.isSafeInteger(input.sequence) || input.sequence < 1 || typeof input.data !== "string" || Buffer.byteLength(input.data) > TERMINAL_LIMITS.inputBytes) throw new Error("Input requires a sequence and at most 16 KiB of text.");
      const digest = createHash("sha256").update(input.data).digest("hex");
      if (input.sequence < item.nextInputSequence) {
        if (item.inputs.get(input.sequence) !== digest) throw new Error("Input receipt expired or conflicts; do not replay it.");
        return this.snapshot(item);
      }
      if (input.sequence !== item.nextInputSequence) throw new Error("Input sequence mismatch; query the terminal before continuing.");
      item.inputs.set(input.sequence, digest); item.nextInputSequence++;
      if (item.inputs.size > TERMINAL_LIMITS.inputReceipts) item.inputs.delete(item.inputs.keys().next().value);
      this.write(item, { action: "input", data: input.data });
      return this.snapshot(item);
    }
    if (input.action === "resize") {
      if (!Number.isInteger(input.cols) || !Number.isInteger(input.rows) || input.cols < TERMINAL_LIMITS.minCols || input.cols > TERMINAL_LIMITS.maxCols || input.rows < TERMINAL_LIMITS.minRows || input.rows > TERMINAL_LIMITS.maxRows) throw new Error("Invalid terminal dimensions.");
      this.write(item, { action: "resize", cols: input.cols, rows: input.rows });
      return this.snapshot(item);
    }
    throw new Error("Unsupported terminal operation.");
  }
  async admitOpen(id, input) {
      if (this.stopped) throw new Error("The main program is stopping.");
      if (!this.shells.includes(input.shell)) throw new Error("Choose a shell advertised by this computer.");
      const cwd = input.cwd || this.defaultCwd;
      if (typeof cwd !== "string" || !path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error("Working directory must be an existing absolute directory on the remote computer.");
      const canonical = fs.realpathSync(cwd);
      let item = this.sessions.get(id);
      const archived = item ? undefined : await this.history.read(id);
      if (archived) {
        if (archived.terminal.shell !== input.shell || archived.terminal.cwd !== canonical) throw new Error("Terminal identity conflict; the existing session is unchanged.");
        return { archived };
      }
      if (item) {
        if (item.shell !== input.shell || item.cwd !== canonical) throw new Error("Terminal identity conflict; the existing session is unchanged.");
        return { item };
      }
      if (this.activeCount >= TERMINAL_LIMITS.activeSessions) throw new Error("This node already has eight active terminals.");
      if (this.sessions.size >= TERMINAL_LIMITS.retainedSessions) {
        let archived = false;
        // One damaged/conflicting receipt must not poison every independent
        // completed session. The hot-table cap also bounds this attempt loop.
        for (const candidate of this.sessions.values()) {
          if (candidate.state !== "exited") continue;
          try {
            await this.history.save({ schemaVersion: 1, terminal: this.snapshot(candidate), inputs: [...candidate.inputs],
              ...(candidate.startError ? { startError: candidate.startError } : {}) });
            this.sessions.delete(candidate.id); archived = true; break;
          } catch (error) {
            this.historyDiagnostics.push({ terminalId: candidate.id, code: String(error.code || error.name || "ARCHIVE_FAILED").slice(0, 64) });
            if (this.historyDiagnostics.length > 8) this.historyDiagnostics.shift();
            // A shared full disk cannot be repaired by trying other identities.
            if (error.code === "ENOSPC") throw error;
          }
        }
        if (!archived) throw new Error("No confirmed exited terminal record could be archived; existing sessions remain available.");
      }
      if (this.stopped) throw new Error("The main program is stopping.");
      item = { id, shell: input.shell, cwd: canonical, state: "starting", createdAt: new Date().toISOString(), nextInputSequence: 1, inputs: new Map() };
      this.sessions.set(id, item);
      this.start(item); return { item };
  }
  write(item, value) {
    if (!item.child?.stdin.writable || item.child.stdin.writableLength > TERMINAL_LIMITS.inputQueueBytes) throw new Error("Terminal input is unavailable or backpressured; query before continuing.");
    item.child.stdin.write(`${JSON.stringify(value)}\n`);
  }
  start(item) {
    const windows = process.platform === "win32";
    const script = fileURLToPath(new URL(windows ? "../terminal/host.ps1" : "../terminal/posix-host.mjs", import.meta.url));
    const executable = windows ? path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe") : process.execPath;
    const child = spawn(executable, windows ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script] : [script], {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(RABI_|RABIROUTE_|CODEX_)/i.test(key))), RABI_TERMINAL_FORCE_CLOSE_MS: String(this.timeout("agent.terminal.forceClose",500)), RABI_TERMINAL_PROCESS_SCAN_MS: String(this.timeout("agent.terminal.processScan",2000)), RABI_TERMINAL_NATIVE_STOP_MS: String(this.timeout("agent.terminal.nativeStop",5000)) }
    });
    item.child = child;
    child.stdout.setEncoding("utf8"); child.stderr.resume(); child.stdin.on("error", () => undefined);
    let buffer = "";
    let resolveReady; let rejectReady;
    item.ready = new Promise((resolve, reject) => {
      let settled = false;
      resolveReady = () => { if (!settled) { settled = true; resolve(); } };
      rejectReady = error => { if (!settled) { settled = true; item.startError = error.message; reject(error); } };
    });
    const deadline = setTimeout(() => { rejectReady(new Error("Native terminal startup timed out.")); child.kill(); }, this.timeout("agent.terminal.start", 30000));
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
        if (event.type === "output" && typeof event.data === "string") publish({ type: "output", data: event.data.slice(0, TERMINAL_LIMITS.eventCodeUnits) });
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
      const deadline = setTimeout(() => item.child.kill(), this.timeout("agent.terminal.stop", 3000));
      try { await item.closed; } finally { clearTimeout(deadline); }
    })();
    return item.closePromise;
  }
  closeAll() { return Promise.all([...this.sessions.values()].map(item => this.close(item))); }
  stop() {
    this.stopped = true;
    this.stopPromise ??= (async () => {
      // Admission may own an archive write before any native child exists.
      // Join it before declaring this owner stopped or closing its children.
      await this.openAdmission;
      await this.closeAll();
    })();
    return this.stopPromise;
  }
}
