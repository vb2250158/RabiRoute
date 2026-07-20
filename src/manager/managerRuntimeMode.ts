export function managerAutostartEnabled(value = process.env.RABIROUTE_MANAGER_AUTOSTART): boolean {
  return value !== "0";
}

export function managerConfigWatcherEnabled(value = process.env.RABIROUTE_MANAGER_AUTOSTART): boolean {
  return managerAutostartEnabled(value);
}
