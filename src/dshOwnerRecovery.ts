import { getTimeoutMs } from "./shared/timeoutSettings.js";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { discoverLocalDsh } from "./dshDiscovery.js";
import { connectDshOwner } from "./dshHttpAuth.js";
import { DshConnectionStore, dshLocalOrigin } from "./dshConnectionStore.js";
import { listDshSessions, type DshPrimaryBinding } from "./dshSessionBridge.js";

export type DshOwnerRecoveryPorts = {
  discover(): { homeDir: string; discoveredBaseUrls: string[] };
  reachable(baseUrl: string): Promise<boolean>;
  authorize(baseUrl: string, homeDir: string): Promise<void>;
  verify(baseUrl: string, binding: DshPrimaryBinding): Promise<void>;
  launch(homeDir: string): Promise<void>;
};
function workspaceKey(value: string) { return value.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase(); }
function localOrigin(value: string): string | undefined { try { return dshLocalOrigin(value); } catch { return undefined; } }

/** Readiness recovery only. Never replay a possibly accepted session.prompt. */
export class DshOwnerRecovery {
  private pending = new Map<string, Promise<string>>();
  constructor(private readonly ports: DshOwnerRecoveryPorts = localDshRecoveryPorts()) {}
  ensure(binding: DshPrimaryBinding): Promise<string> {
    if (!localOrigin(binding.baseUrl)) return Promise.resolve(binding.baseUrl);
    const key = `${binding.baseUrl}\n${binding.sessionId}\n${workspaceKey(binding.cwd)}`;
    const old = this.pending.get(key); if (old) return old;
    const work = this.recover(binding).finally(() => this.pending.delete(key));
    this.pending.set(key, work); return work;
  }
  private async recover(binding: DshPrimaryBinding): Promise<string> {
    let discovery = this.ports.discover();
    const candidates = () => [...new Set([binding.baseUrl, ...discovery.discoveredBaseUrls.slice().reverse()].map(localOrigin).filter((v): v is string => !!v))];
    const find = async () => {
      for (const baseUrl of candidates()) {
        if (!await this.ports.reachable(baseUrl)) continue;
        // A reachable but different/unauthorized owner must not cause a new session.
        await this.ports.authorize(baseUrl, discovery.homeDir);
        await this.ports.verify(baseUrl, binding);
        return baseUrl;
      }
      return undefined;
    };
    let ready = await find(); if (ready) return ready;
    await this.ports.launch(discovery.homeDir);
    discovery = this.ports.discover(); ready = await find();
    if (!ready) throw new Error("DSH 启动后仍未就绪，将自动重试");
    return ready;
  }
}

function localDshRecoveryPorts(): DshOwnerRecoveryPorts {
  const store = new DshConnectionStore();
  return {
    discover: () => discoverLocalDsh(),
    reachable: async baseUrl => {
      try {
        const response = await fetch(baseUrl + "/", { redirect: "manual", signal: AbortSignal.timeout(getTimeoutMs("agent.dsh.recoveryProbe", 2000)) });
        await response.body?.cancel();
        return [200, 303, 401].includes(response.status);
      } catch { return false; }
    },
    authorize: async (baseUrl, homeDir) => {
      const saved = store.resolve(baseUrl);
      if (saved?.state === "disconnected") throw new Error("DSH 连接已被手动断开，请在连接设置中恢复授权");
      if (saved?.state === "connected") return;
      // Only the registered local Home's bounded current launch log is consulted.
      const file = await fs.open(path.join(homeDir, "logs", "web-host.stdout.log"), "r");
      let tail: string;
      try {
        const stat = await file.stat(), size = Math.min(stat.size, 256 * 1024), buffer = Buffer.alloc(size);
        const read = await file.read(buffer, 0, size, stat.size - size); tail = buffer.subarray(0, read.bytesRead).toString("utf8");
      } finally { await file.close(); }
      let launchUrl = "";
      for (const match of tail.matchAll(/dsh web: (https?:\/\/[^\s<>"']+)/g)) {
        try { if (new URL(match[1]).origin === baseUrl) launchUrl = match[1]; } catch { /* unrelated banner */ }
      }
      if (!launchUrl) throw new Error("DSH 当前启动凭据不可用，将自动重试");
      await connectDshOwner(launchUrl, store.readMetadata().revision, store, AbortSignal.timeout(getTimeoutMs("agent.dsh.recoveryConnect", 12000)));
    },
    verify: async (baseUrl, binding) => {
      const rows = await listDshSessions({ baseUrl, signal: AbortSignal.timeout(getTimeoutMs("agent.dsh.recoverySessions", 5000)), limit: Number.MAX_SAFE_INTEGER });
      const session = rows.find(row => row.id === binding.sessionId);
      if (!session || !session.cwd || workspaceKey(session.cwd) !== workspaceKey(binding.cwd)) {
        throw new Error("DSH 原会话或工作区不匹配，未创建替代会话");
      }
    },
    launch: async homeDir => {
      if (process.platform !== "win32") throw new Error("本机没有受支持的 DSH 自动启动入口");
      const launcher = path.join(homeDir, "start-dsh.ps1"); await fs.access(launcher);
      await new Promise<void>((resolve, reject) => {
        const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", launcher],
          { cwd: homeDir, windowsHide: true, stdio: "ignore" });
        const deadline = setTimeout(() => { child.kill(); reject(new Error("DSH 启动超时，将自动重试")); }, getTimeoutMs("deadline.dshOwnerRecovery.localDshRecoveryPorts", 90_000));
        child.once("error", error => { clearTimeout(deadline); reject(error); });
        child.once("exit", code => { clearTimeout(deadline); code === 0 ? resolve() : reject(new Error("DSH 启动入口失败，将自动重试")); });
      });
    }
  };
}
