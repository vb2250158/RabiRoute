import test from "node:test";
import assert from "node:assert/strict";
import { createPosixTerminalHost } from "../terminal/posix-host.mjs";
import { TerminalService } from "../lib/terminal-service.mjs";
import os from "node:os";
import { randomUUID } from "node:crypto";

test("POSIX PTY uses the explicit shell, streams Unicode, resizes, and closes owned processes", () => {
  const events = []; const calls = []; let data; let exit;
  const terminal = { pid: 4312, onData: callback => { data = callback; }, onExit: callback => { exit = callback; },
    write: text => calls.push(["write", text]), resize: (cols, rows) => calls.push(["resize", cols, rows]), kill: signal => calls.push(["pty-kill", signal]) };
  const host = createPosixTerminalHost({ spawnTerminal: (...args) => { calls.push(["spawn", ...args]); return terminal; },
    publish: event => events.push(event), descendants: pid => { assert.equal(pid, terminal.pid); return [4313, 4314]; },
    kill: (pid, signal) => calls.push(["kill", pid, signal]), onClosed: () => calls.push(["closed"]) });
  assert.throws(() => host.handle({ action: "open", shell: "cmd", cwd: "/tmp" }), /explicit POSIX/);
  host.handle({ action: "open", shell: "zsh", cwd: "/tmp" });
  assert.equal(calls[0][1], "/bin/zsh");
  assert.equal(calls[0][3].cwd, "/tmp");
  assert.equal(calls[0][3].name, "xterm-256color");
  data("中文\r\n");
  assert.deepEqual(events.map(event => event.type), ["ready", "output"]);
  assert.equal(events[1].data, "中文\r\n");
  host.handle({ action: "input", data: "printf hello\r" });
  host.handle({ action: "resize", cols: 110, rows: 35 });
  assert.ok(calls.some(call => call[0] === "resize" && call[1] === 110));
  host.close(); host.close(); exit({ exitCode: 0 });
  assert.equal(calls.filter(call => call[0] === "closed").length, 1);
  assert.deepEqual(calls.filter(call => call[0] === "kill").map(call => call[1]), [4314, 4313, -4312]);
  assert.throws(() => host.handle({ action: "input", data: "later" }), /closing/);
});

test("POSIX PTY rejects repeated open, malformed resize and excessive input without writes", () => {
  const terminal = { pid: 1, onData() {}, onExit() {}, write() { throw new Error("Unexpected write"); }, kill() {} };
  const host = createPosixTerminalHost({ spawnTerminal: () => terminal, publish() {}, descendants: () => [], kill() {} });
  host.handle({ action: "open", shell: "bash", cwd: "/tmp" });
  assert.throws(() => host.handle({ action: "open", shell: "bash", cwd: "/tmp" }), /explicit POSIX/);
  assert.throws(() => host.handle({ action: "resize", cols: 0, rows: 30 }), /Invalid/);
  assert.throws(() => host.handle({ action: "input", data: "x".repeat(16385) }), /Invalid/);
  host.close();
});

test("native POSIX terminal runs a selected shell and preserves input receipts", { skip: process.platform === "win32", timeout: 30000 }, async t => {
  const events = []; const service = new TerminalService({ defaultCwd: os.tmpdir(), emit: event => events.push(event) });
  t.after(() => service.stop());
  const terminalId = randomUUID();
  const shell = service.shells[0];
  const opened = await service.execute({ action: "open", terminalId, shell });
  assert.equal(opened.state, "running");
  const data = "printf 'RABI_%s\\n' 'POSIX_OK'\r";
  await service.execute({ action: "input", terminalId, sequence: 1, data });
  const deadline = Date.now() + 10000;
  while (!events.some(event => event.data?.includes("RABI_POSIX_OK")) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(events.some(event => event.data?.includes("RABI_POSIX_OK")));
  assert.equal((await service.execute({ action: "input", terminalId, sequence: 1, data })).nextInputSequence, 2);
  assert.equal((await service.execute({ action: "close", terminalId })).state, "exited");
});
