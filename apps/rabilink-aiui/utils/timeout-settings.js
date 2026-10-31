import { sha256Text } from "../../../packages/rabi-api-contract/fingerprint.mjs";
// Settings are a cache of an authenticated PC response, scoped by connection and target.
const snapshots = new Map();
let storage;
export function configureTimeoutStorage(value) { storage = value; }
const scope = (config, target) => JSON.stringify([String(config.relayBaseUrl || ''), sha256Text(String(config.token || '')), String(target || config.targetDeviceId || '')]);
export function adoptTimeoutSettings(config, target, value) {
  const next = Object.create(null);
  if (value !== undefined) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) value = {};
    for (const key of Object.keys(value)) {
      if (!Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > 2147483647) continue;
      next[key] = value[key];
    }
  }
  const id = scope(config, target);
  storage?.setStorageSync('rabi-timeout-cache:' + id, next);
  snapshots.set(id, next);
}
export function requestTimeout(config, target, key, fallback) {
  const id = scope(config, target);
  const cached = snapshots.get(id) || storage?.getStorageSync('rabi-timeout-cache:' + id);
  const value = cached?.[key];
  return Number.isSafeInteger(value) && value >= 1 && value <= 2147483647 ? value : fallback;
}
