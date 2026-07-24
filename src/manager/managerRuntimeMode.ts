export function managerAutostartEnabled(value = process.env.RABIROUTE_MANAGER_AUTOSTART): boolean {
  return value !== "0";
}

export function managerConfigWatcherEnabled(value = process.env.RABIROUTE_MANAGER_AUTOSTART): boolean {
  return managerAutostartEnabled(value);
}

export function managerReadOnlyEnabled(value = process.env.RABIROUTE_MANAGER_READ_ONLY): boolean {
  return value === "1";
}

const readOnlyHttpMethods = new Set(["GET", "HEAD", "OPTIONS"]);

export function managerReadOnlyRequestAllowed(method: string | undefined): boolean {
  return readOnlyHttpMethods.has(String(method || "GET").toUpperCase());
}
