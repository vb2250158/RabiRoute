/** Browser display preference; this never changes the provider's device directory. */
export type DeviceUsage = { deviceId: string; count: number; lastOpenedAt: number };
type UsageStorage = Pick<Storage, "getItem" | "setItem">;
const storageKey = "rabi-home-device-usage-v1";
const maxEntries = 500;
function compareUsage(a: DeviceUsage, b: DeviceUsage) { return b.count - a.count || b.lastOpenedAt - a.lastOpenedAt; }
export function readDeviceUsage(storage: UsageStorage): DeviceUsage[] {
 try {
  const text = storage.getItem(storageKey);
  if (!text || text.length > 128 * 1024) return [];
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 || !("devices" in value) || !Array.isArray(value.devices)) return [];
  const seen = new Set<string>();
  return value.devices.slice(0, maxEntries).filter((item): item is DeviceUsage => {
   if (!item || typeof item !== "object" || typeof item.deviceId !== "string" || !item.deviceId || item.deviceId.length > 256 || seen.has(item.deviceId) || !Number.isSafeInteger(item.count) || item.count < 1 || !Number.isSafeInteger(item.lastOpenedAt) || item.lastOpenedAt < 0 || item.lastOpenedAt > 8640000000000000) return false;
   seen.add(item.deviceId); return true;
  }).map(({ deviceId, count, lastOpenedAt }) => ({ deviceId, count, lastOpenedAt }));
 } catch { return []; }
}
export function recordDeviceOpen(storage: UsageStorage, deviceId: string, now = Date.now()): void {
 if (!deviceId || deviceId.length > 256 || !Number.isSafeInteger(now) || now < 0 || now > 8640000000000000) return;
 const history = readDeviceUsage(storage), previous = history.find(item => item.deviceId === deviceId);
 const next = [...history.filter(item => item.deviceId !== deviceId), { deviceId, count: Math.min(Number.MAX_SAFE_INTEGER, (previous?.count || 0) + 1), lastOpenedAt: now }].sort(compareUsage).slice(0, maxEntries);
 try { storage.setItem(storageKey, JSON.stringify({ version: 1, devices: next })); } catch { /* Browser storage may be disabled; the device can still be opened. */ }
}
export function rankDevices<T extends { deviceId: string }>(devices: readonly T[], usage: readonly DeviceUsage[]): T[] {
 const history = new Map(usage.map(item => [item.deviceId, item]));
 return devices.map((device, index) => ({ device, index })).sort((a, b) => {
  const left = history.get(a.device.deviceId), right = history.get(b.device.deviceId);
  return (right?.count || 0) - (left?.count || 0) || (right?.lastOpenedAt || 0) - (left?.lastOpenedAt || 0) || a.index - b.index;
 }).map(item => item.device);
}
