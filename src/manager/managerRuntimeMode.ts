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
  running: boolean;
  needsRestart: boolean;
}): GatewayRuntimeSyncAction {
  if (input.enabled && input.running && input.needsRestart) return "restart";
  if (!input.enabled && input.running) return "stop";
  if (input.managerShouldAutostart && input.enabled && !input.running) return "start";
  return "none";
}

export function managerReadOnlyEnabled(value = process.env.RABIROUTE_MANAGER_READ_ONLY): boolean {
  return value === "1";
}

const readOnlyHttpMethods = new Set(["GET", "HEAD", "OPTIONS"]);

export function managerReadOnlyRequestAllowed(method: string | undefined): boolean {
  return readOnlyHttpMethods.has(String(method || "GET").toUpperCase());
}
