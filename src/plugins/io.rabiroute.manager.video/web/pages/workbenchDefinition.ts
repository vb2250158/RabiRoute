import type { WorkbenchDefinition } from "./workbenchEditor";

// Definitions describe the installed plugin and are shared by the canvas and its panels.
let cached: { value: WorkbenchDefinition; until: number } | undefined;
let pending: Promise<WorkbenchDefinition> | undefined;

export function loadWorkbenchDefinition(fetchImpl: typeof fetch = fetch): Promise<WorkbenchDefinition> {
  if (cached && Date.now() < cached.until) return Promise.resolve(cached.value);
  if (pending) return pending;
  pending = fetchImpl("/api/video/v2/definition", { signal: AbortSignal.timeout(10000) })
    .then(async response => {
      if (!response.ok) throw new Error("无法读取节点定义。");
      const value: WorkbenchDefinition = await response.json();
      cached = { value, until: Date.now() + 60_000 };
      return value;
    }).finally(() => { pending = undefined; });
  return pending;
}
