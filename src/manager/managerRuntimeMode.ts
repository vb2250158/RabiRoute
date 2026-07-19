export function managerAutostartEnabled(value = process.env.RABIROUTE_MANAGER_AUTOSTART): boolean {
  return value !== "0";
}
