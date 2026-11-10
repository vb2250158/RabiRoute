import { ComputerQtClient } from "./computer-qt-client.mjs";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

/** One pipe owner per target. Native input, drawing and capture have separate executors. */
export class NativeComputerClient extends EventEmitter {
  constructor({ timeout = (_key, fallback) => fallback, children = new Set(), launch = spawn, executable, args, qtPresentation, getPresentationTheme } = {}) {
    super(); Object.assign(this, { timeout, children, launch, executable, args });
    this.qt = qtPresentation ? new ComputerQtClient({ ...qtPresentation, timeout, children, getPresentationTheme, onExit: controlSessionId => { void this.request("control.end", { controlSessionId, reason: "user-exit" }).catch(error => this.emit("diagnostic", { code: error.code, message: error.message })); } }) : null;
    this.qtAvailable = Boolean(qtPresentation); this.pending = new Map(); this.child = null; this.closed = null; this.stopping = false;
  }
  start() {
    if (this.stopping) throw new Error("Computer native owner is stopping.");
    if (this.child) return;
    const native = fileURLToPath(new URL("../dist/native/RabiAgent.Computer.exe", import.meta.url));
    const source = fileURLToPath(new URL("../desktop/computer-native.cs", import.meta.url));
    const sourceHash = fs.existsSync(source) ? createHash("sha256").update(fs.readFileSync(source, "utf8").replaceAll("\r\n", "\n")).digest("hex") : null;
    const compiledMatches = fs.existsSync(native) && (!sourceHash || fs.existsSync(path.join(path.dirname(native), `computer-${sourceHash}.dll`)));
    const executable = this.executable ?? (compiledMatches ? native : path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"));
    const args = this.args ?? (executable === native ? [] : ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL("../desktop/computer.ps1", import.meta.url))]);
    // Never pass business credentials into the native desktop helper.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(RABI_|RABIROUTE_|CODEX_)/i.test(key)));
    const child = this.launch(executable, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env });
    this.child = child; this.children.add(child); let fragments = [];
    this.closed = new Promise(resolve => child.once("close", (code, signal) => {
      this.children.delete(child); if (this.child === child) this.child = null;
      const error = Object.assign(new Error(`Native computer helper closed (${signal ?? code}); query the original request.`), { code: "COMPUTER_RESULT_UNCERTAIN", uncertain: true });
      for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
      this.pending.clear(); this.emit("closed", error);
      void Promise.resolve(this.qt?.close()).then(() => this.emit("retired"), cause => this.emit("diagnostic", { code: "COMPUTER_QT_CLOSE_UNCONFIRMED", message: cause.message }));
      resolve();
    }));
    child.on("error", cause => {
      const error = Object.assign(new Error("Native computer helper could not start.", { cause }), { code: "COMPUTER_NATIVE_START_FAILED", uncertain: Boolean(child.pid) });
      for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
      this.pending.clear(); this.emit("diagnostic", { code: error.code, message: error.message });
    });
    child.stdin.on("error", () => {}); child.stderr.resume(); child.stdout.setEncoding("utf8");
    child.stdout.on("data", data => {
      let offset = 0;
      for (;;) {
        const end = data.indexOf("\n", offset);
        if (end < 0) { if (offset < data.length) fragments.push(data.slice(offset)); break; }
        const tail = data.slice(offset, end); offset = end + 1;
        const line = fragments.length ? fragments.concat(tail).join("") : tail; fragments = [];
        if (!line.trim()) continue;
        let message; try { message = JSON.parse(line); } catch { this.emit("diagnostic", { code: "COMPUTER_NATIVE_INVALID_FRAME" }); continue; }
        if (message.event) {
          if (message.event === "presentation" && this.qtAvailable) void this.qt.update(message.data).catch(error => { this.qtAvailable = false; this.emit("diagnostic", { code: "COMPUTER_QT_UNAVAILABLE", message: error.message }); });
          this.emit(message.event, message.data); continue;
        }
        const entry = this.pending.get(message.id); if (!entry) continue;
        this.pending.delete(message.id); clearTimeout(entry.timer);
        if (message.error) entry.reject(Object.assign(new Error(message.error.message ?? String(message.error)), { code: message.error.code, uncertain: message.error.uncertain === true }));
        else if (message.result?.renderRevision && this.qtAvailable) void this.qt.shown(message.result.renderRevision).then(() => entry.resolve(message.result), entry.reject);
        else entry.resolve(message.result);
      }
    });
  }
  async request(action, body = {}, options = {}) {
    if (this.qt && (action === "control.begin" || action.startsWith("annotation."))) {
      try { await this.qt.start(); this.qtAvailable = true; }
      catch (cause) {
        this.qtAvailable = false;
        if (action === "annotation.show" || action === "annotation.update" || action === "annotation.track.start") throw Object.assign(new Error("Qt screen annotation is unavailable; terminal, files and native input remain usable.", { cause }), { code: "COMPUTER_ANNOTATION_UNAVAILABLE" });
      }
    }
    options.beforeSend?.();
    this.start(); const id = randomUUID();
    body = { ...body, renderer: this.qt ? "qt" : "native", controlRenderer: this.qtAvailable ? "qt" : "native" };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error("Native computer result remains unconfirmed; query the original request before continuing."), { code: "COMPUTER_RESULT_UNCERTAIN", uncertain: true }));
      }, this.timeout("agent.computer.process", 30000));
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ ...body, id, action }) + "\n", error => {
        if (!error || !this.pending.delete(id)) return;
        clearTimeout(timer); reject(Object.assign(error, { code: "COMPUTER_RESULT_UNCERTAIN", uncertain: true }));
      });
    });
  }
  setPresentationTheme(snapshot) { return this.qt?.setTheme(snapshot) ?? Promise.resolve(); }
  async close() {
    if (this.stopping) return Promise.all([this.closed, this.qt?.close()]);
    this.stopping = true;
    const child = this.child; if (!child) { await this.qt?.close(); return; }
    // EOF is the native cleanup instruction. It releases its own keys before UI/process teardown.
    child.stdin.end();
    let timer;
    try { await Promise.all([this.qt?.close(), Promise.race([this.closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Native computer close remains unconfirmed.")), this.timeout("agent.computer.process", 30000)); })])]); }
    finally { clearTimeout(timer); }
  }
}
