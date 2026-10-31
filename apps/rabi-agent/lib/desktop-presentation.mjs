import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

// Serialized into the stable owner. The presentation never reads private config,
// contacts Manager, launches a worker, or acquires an independent ownership lease.
export function createDesktopPresentation({ currentEntry, snapshot, command, onFailure, timeout = (_key, fallback) => fallback, enabled = process.platform === "win32" }) {
  let child; let closing = false; let failures = 0; let retry;
  const publish = () => {
    if (child?.stdin.writable) child.stdin.write(`${JSON.stringify({ type: "snapshot", ...snapshot() })}\n`);
  };
  const start = () => {
    if (!enabled || closing) return;
    const script = path.join(path.dirname(currentEntry()), "desktop", "tray.ps1");
    // Older signed releases remain headless until upgraded. No alternate owner.
    if (!fs.existsSync(script)) return;
    const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    child = spawn(executable, ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", script], {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(systemroot|windir|temp|tmp|userprofile|appdata|localappdata|path|psmodulepath)$/i.test(key)))
    });
    const owned = child;
    const readyDeadline = setTimeout(() => owned.kill(), timeout("agent.tray.start", 15000));
    let buffer = ""; let pending = false;
    owned.stdin.on("error", () => undefined);
    owned.stderr.on("data", () => undefined); // Never forward private host diagnostics.
    owned.stdout.setEncoding("utf8");
    owned.stdout.on("data", bytes => {
      buffer += bytes.toString("utf8");
      if (buffer.length > 65536) { owned.kill(); return; }
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === "ready") { clearTimeout(readyDeadline); publish(); continue; }
        if (event.type !== "command" || pending || child !== owned || closing) continue;
        if (!["start", "pause", "restart", "reconnect", "open-manager", "startup", "exit"].includes(event.action)) continue;
        pending = true;
        Promise.resolve().then(() => command(event.action, event.enabled)).catch(() => onFailure("操作失败，请查看连接器状态。"))
          .finally(() => { pending = false; publish(); });
      }
    });
    owned.once("error", () => undefined);
    owned.once("close", () => {
      clearTimeout(readyDeadline);
      if (child !== owned || closing) return;
      child = undefined;
      if (failures++ >= 3) { onFailure("托盘无法运行，主程序将退出。", true); return; }
      onFailure("托盘已退出，主程序正在恢复。", false);
      retry = setTimeout(start, 1000 * failures);
    });
    publish();
  };
  start();
  return {
    publish,
    get pid() { return child?.pid; },
    async close() {
      closing = true; clearTimeout(retry);
      const owned = child;
      if (!owned || owned.exitCode !== null) return;
      await new Promise(resolve => {
        const deadline = setTimeout(() => owned.kill(), timeout("agent.tray.stop", 3000));
        owned.once("close", () => { clearTimeout(deadline); resolve(); });
        owned.stdin.end(); // EOF is also the parent-death contract.
      });
    }
  };
}
