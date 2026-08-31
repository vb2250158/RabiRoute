export function managerAutostartEnabled(value = process.env.RABIROUTE_MANAGER_AUTOSTART): boolean {
  return value !== "0";
}

export function managerConfigWatcherEnabled(value = process.env.RABIROUTE_MANAGER_AUTOSTART): boolean {
  return managerAutostartEnabled(value);
}

export type GatewayRuntimeSyncAction = "none" | "start" | "restart" | "stop";

export function gatewayRuntimeSyncAction(input: {
  managerShouldAutostart: boolean;
  enabled: boolean;
  runtimeRequired: boolean;
  running: boolean;
  needsRestart: boolean;
}): GatewayRuntimeSyncAction {
  const shouldRun = input.enabled && input.runtimeRequired;
  if (shouldRun && input.running && input.needsRestart) return "restart";
  if (!shouldRun && input.running) return "stop";
  if (input.managerShouldAutostart && shouldRun && !input.running) return "start";
  return "none";
}

export type GatewayRuntimeStartDecision = "start" | "skip-disabled" | "skip-not-required" | "already-running";

export function gatewayRuntimeStartDecision(input: {
  enabled: boolean;
  runtimeRequired: boolean;
  running: boolean;
}): GatewayRuntimeStartDecision {
  if (!input.enabled) return "skip-disabled";
  if (!input.runtimeRequired) return "skip-not-required";
  if (input.running) return "already-running";
  return "start";
}

export function managerReadOnlyEnabled(value = process.env.RABIROUTE_MANAGER_READ_ONLY): boolean {
  return value === "1";
}

const readOnlyHttpMethods = new Set(["GET", "HEAD", "OPTIONS"]);

export function managerReadOnlyRequestAllowed(method: string | undefined, pathname = ""): boolean {
  const normalizedMethod = String(method || "GET").toUpperCase();
  if (normalizedMethod === "POST" && pathname === "/_rabiroute/host/shutdown") return true;
  return readOnlyHttpMethods.has(normalizedMethod);
}
