import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { isWorkbuddyDesktopRelayReady } from "./workbuddyDesktopRelay.js";
import { workbuddyHomeDir } from "./workbuddyHome.js";

const execute = promisify(execFile);

type DesktopBootstrapPaths = { scannerEntry: string; applicationRoot: string };

async function launchInteractiveWorker({ scannerEntry, applicationRoot }: DesktopBootstrapPaths) {
  if (!scannerEntry || !path.isAbsolute(scannerEntry) || path.basename(scannerEntry) !== "scan.mjs"
    || path.basename(path.dirname(scannerEntry)) !== "workers") {
    throw new Error("WorkBuddy 桌面连接器找不到实际插件包。");
  }
  const packageRoot = path.dirname(path.dirname(scannerEntry));
  const launcher = path.join(packageRoot, "assets", "desktop-launch.ps1");
  const worker = path.join(packageRoot, "workers", "desktop-companion.mjs");
  try { await Promise.all([access(launcher), access(worker)]); }
  catch { throw new Error("WorkBuddy 桌面创建尚未连接，当前插件缺少已构建的桌面连接器。"); }
  if (process.release.name !== "node" || !process.versions.node || !path.isAbsolute(process.execPath)) {
    throw new Error("WorkBuddy 桌面连接器需要当前宿主的 Node 运行环境。");
  }
  const { stdout } = await execute("whoami.exe", ["/user", "/fo", "csv", "/nh"], { windowsHide: true, timeout: 4_000 });
  const sid = /,"(S-1-(?:\d+-)*\d+)"\s*$/i.exec(stdout.trim())?.[1];
  if (!sid) throw new Error("无法确认 WorkBuddy 桌面连接器的 Windows 用户。");
  await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-File", launcher,
    "-Node", process.execPath, "-ApplicationRoot", applicationRoot, "-OwnerSid", sid, "-WorkBuddyHome", workbuddyHomeDir()],
    { windowsHide: true, timeout: 8_000 });
}

/** Shared readiness per Manager and single native ownership per Windows desktop. */
export function createWorkbuddyDesktopBootstrap(paths: DesktopBootstrapPaths, dependencies = {
  isReady: isWorkbuddyDesktopRelayReady, launch: launchInteractiveWorker, supported: process.platform === "win32", timeoutMs: 25_000
}) {
  let starting: Promise<void> | undefined;
  return async function ensureReady(signal?: AbortSignal, assertCurrent?: () => void): Promise<void> {
    signal?.throwIfAborted();
    if (await dependencies.isReady()) return;
    signal?.throwIfAborted();
    assertCurrent?.();
    if (!dependencies.supported) throw new Error("WorkBuddy 桌面创建需要 Windows 登录会话。");
    starting ??= (async () => {
      await dependencies.launch(paths);
      const deadline = performance.now() + dependencies.timeoutMs;
      while (performance.now() < deadline) {
        if (await dependencies.isReady()) return;
        await delay(200);
      }
      throw new Error("WorkBuddy 桌面连接器未就绪。请确认桌面已登录、WorkBuddy 已安装，且当前没有其它启动方式打开的 WorkBuddy 客户端。");
    })().finally(() => { starting = undefined; });
    if (!signal) return starting;
    let abort: (() => void) | undefined;
    try {
      await Promise.race([starting, new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      })]);
    } finally { if (abort) signal.removeEventListener("abort", abort); }
  };
}
