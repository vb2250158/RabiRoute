import { spawnSync } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

const configuredTimeout = (name,fallback) => { const value=Number(process.env[name]); return Number.isInteger(value)&&value>=1&&value<=2147483647 ? value : fallback; };

/** The helper owns its PTY and closes it when the connector's input pipe closes. */
export function createPosixTerminalHost({ spawnTerminal, publish, descendants = processDescendants, kill = process.kill.bind(process), onClosed = () => undefined }) {
  let terminal; let closing = false; let exited = false; let finished = false; let forceClose;
  const finish = () => { if (!finished) { finished = true; clearTimeout(forceClose); onClosed(); } };
  const close = () => {
    if (closing) return;
    closing = true;
    if (terminal) {
      // Snapshot before signalling the parent so tracked children cannot be reparented first.
      const owned = descendants(terminal.pid);
      for (const pid of owned.reverse()) { try { kill(pid, "SIGKILL"); } catch { /* Already exited. */ } }
      try { kill(-terminal.pid, "SIGHUP"); } catch { /* The PTY may already have exited. */ }
      try { terminal.kill("SIGHUP"); } catch { /* Already exited. */ }
      if (!exited) {
        forceClose = setTimeout(() => {
          for (const pid of owned) { try { kill(pid, "SIGKILL"); } catch { /* Already exited. */ } }
          try { kill(-terminal.pid, "SIGKILL"); } catch { /* Already exited. */ }
          try { terminal.kill("SIGKILL"); } catch { /* Already exited. */ }
        }, configuredTimeout("RABI_TERMINAL_FORCE_CLOSE_MS",500));
        forceClose.unref();
      }
    }
    if (!terminal || exited) finish();
  };
  const handle = input => {
    if (closing) throw new Error("Terminal host is closing.");
    if (input.action === "open") {
      if (terminal || !["zsh", "bash", "sh"].includes(input.shell) || typeof input.cwd !== "string" || !path.isAbsolute(input.cwd)) throw new Error("An explicit POSIX shell and absolute working directory are required.");
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(RABI_|RABIROUTE_|CODEX_)/i.test(key)));
      terminal = spawnTerminal(`/bin/${input.shell}`, ["-l"], { name: "xterm-256color", cols: 100, rows: 30, cwd: input.cwd, env });
      terminal.onData(data => {
        if (closing) return;
        // Keep JSON transport lines below the connector's bounded framing budget.
        for (let offset = 0; offset < data.length; offset += 4096) publish({ type: "output", data: data.slice(offset, offset + 4096) });
      });
      terminal.onExit(event => { if (!exited) { exited = true; publish({ type: "exit", code: event.exitCode }); close(); finish(); } });
      publish({ type: "ready", pid: terminal.pid });
      return;
    }
    if (!terminal || exited) throw new Error("Terminal is not running.");
    if (input.action === "input" && typeof input.data === "string" && Buffer.byteLength(input.data) <= 16384) terminal.write(input.data);
    else if (input.action === "resize" && Number.isInteger(input.cols) && Number.isInteger(input.rows) && input.cols >= 20 && input.cols <= 400 && input.rows >= 5 && input.rows <= 200) terminal.resize(input.cols, input.rows);
    else throw new Error("Invalid terminal operation.");
  };
  return { handle, close };
}

function processDescendants(parent) {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8", timeout: configuredTimeout("RABI_TERMINAL_PROCESS_SCAN_MS",2000), maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) return [];
  const children = new Map();
  for (const line of result.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (match) { const owner = Number(match[2]); const entries = children.get(owner) || []; entries.push(Number(match[1])); children.set(owner, entries); }
  }
  const owned = []; const pending = [...children.get(parent) || []]; const seen = new Set([parent]);
  while (pending.length) { const pid = pending.shift(); if (seen.has(pid)) continue; seen.add(pid); owned.push(pid); pending.push(...children.get(pid) || []); }
  return owned;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const publish = event => process.stdout.write(`${JSON.stringify(event)}\n`);
  try {
    const pty = await import("node-pty");
    const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    const host = createPosixTerminalHost({ spawnTerminal: pty.spawn, publish, onClosed: () => { input.close(); process.stdout.end(); } });
    input.on("line", line => { try { if (line.length > 65536) throw new Error("Terminal input frame is too large."); host.handle(JSON.parse(line)); } catch (error) { publish({ type: "error", message: error.message }); host.close(); } });
    input.on("close", host.close);
    process.on("SIGTERM", host.close); process.on("SIGINT", host.close);
  } catch {
    publish({ type: "error", message: "POSIX terminal dependency node-pty is unavailable. Install this connector's optional dependencies; macOS native builds may require Xcode Command Line Tools." });
  }
}
