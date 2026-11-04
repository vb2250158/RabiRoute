import type { HookInstaller } from "./hookInstallationShared.js";
export { workbuddyHomeDir } from "../workbuddyHome.js";
export { workbuddyHookPaths, probeWorkbuddyHook } from "./workbuddyHookInstallation.js";
export { antigravityHookPaths } from "./antigravityHookInstallation.js";

const pending = new Map<string, Promise<{ message: string }>>();

/** Compatibility installer entry; native packages import only their own platform implementation. */
export function updateAgentHooks(rootDir: string, adapter: string, run?: HookInstaller, options: { signal?: AbortSignal } = {}): Promise<{ message: string }> {
  const key = `${rootDir}:${adapter}`;
  const previous = pending.get(key);
  if (previous) return previous;
  const operation = (async () => {
    if (adapter === "codex") return (await import("./codexHookInstallation.js")).updateHooks(rootDir, run);
    if (adapter === "dsh") return (await import("./dshHookInstallation.js")).updateHooks(rootDir, run);
    if (adapter === "workbuddy") return (await import("./workbuddyHookInstallation.js")).updateHooks(rootDir, run, options);
    if (adapter === "antigravity") return (await import("./antigravityHookInstallation.js")).updateHooks(rootDir, run, options);
    throw new Error("当前 Agent 尚未提供 Hook 更新安装包。");
  })().finally(() => pending.delete(key));
  pending.set(key, operation);
  return operation;
}
