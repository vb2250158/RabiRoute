import { spawn } from "node:child_process";

const SYSTEM_THEME = Object.freeze({ theme: "system" });

/** Full-host Qt presentation only. Native input and its emergency exit remain independent. */
export class ComputerQtClient {
  constructor({ command, args, timeout, children, onExit = () => {}, getPresentationTheme, launch = spawn }) {
    Object.assign(this, { command, args, timeout, children, onExit, launch, getPresentationTheme });
    this.waiters = new Set(); this.revision = 0; this.child = null; this.ready = null;
  }
  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const child = this.launch(this.command, this.args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(RABI_|RABIROUTE_|CODEX_)/i.test(key))) });
      this.child = child; this.children.add(child); let buffer = "";
      const timer = setTimeout(() => reject(new Error("Qt presentation startup was not confirmed.")), this.timeout("agent.computer.process", 30000));
      child.stdin.on("error", () => {}); child.stderr.resume(); child.stdout.setEncoding("utf8");
      child.on("error", error => { clearTimeout(timer); reject(error); });
      this.closed = new Promise(done => child.once("close", () => {
        clearTimeout(timer); this.children.delete(child); this.child = null;
        const error = new Error("Qt screen presentation closed."); reject(error);
        for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.reject(error); }
        this.waiters.clear(); done();
      }));
      child.stdout.on("data", data => {
        buffer += data;
        for (;;) {
          const end = buffer.indexOf("\n"); if (end < 0) break;
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let message; try { message = JSON.parse(line); } catch { continue; }
          if (message.event === "ready") { clearTimeout(timer); resolve(); }
          if (message.event === "exit-control") this.onExit(message.controlSessionId);
          if (message.event === "shown") {
            this.revision = message.revision; this.lastShown = message;
            for (const waiter of this.waiters) if (waiter.revision <= this.revision) { clearTimeout(waiter.timer); this.waiters.delete(waiter); waiter.resolve(message); }
          }
        }
      });
    }); return this.ready;
  }
  async setTheme(snapshot) {
    this.presentationTheme = snapshot;
    if (this.child && this.lastSnapshot) await this.update(this.lastSnapshot);
  }
  async update(snapshot) {
    await this.start();
    if (!this.child) throw new Error("Qt presentation is unavailable.");
    this.lastSnapshot = snapshot;
    const theme = this.presentationTheme ?? this.getPresentationTheme?.() ?? SYSTEM_THEME;
    let value = snapshot;
    if (theme && theme !== this.lastSentTheme) { value = { ...snapshot, presentationTheme: theme }; this.lastSentTheme = theme; }
    this.child.stdin.write(JSON.stringify(value) + "\n");
  }
  shown(revision) {
    if (this.revision >= revision) return Promise.resolve({ revision });
    return new Promise((resolve, reject) => {
      const waiter = { revision, resolve, reject };
      waiter.timer = setTimeout(() => { this.waiters.delete(waiter); reject(new Error("Qt drawing result remains unconfirmed.")); }, this.timeout("agent.computer.process", 30000));
      this.waiters.add(waiter);
    });
  }
  async close() {
    const child = this.child; if (!child) return;
    child.stdin.end(); let timer;
    try { await Promise.race([this.closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Qt presentation process close remains unconfirmed.")), this.timeout("agent.computer.process", 30000)); })]); }
    finally { clearTimeout(timer); }
  }
}
