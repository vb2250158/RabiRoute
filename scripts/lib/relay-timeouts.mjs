import { getTimeoutMs } from './timeout-settings.mjs';
export const relayTimeout = (key, fallback) => getTimeoutMs(`relay.${key}`, fallback);
export function clientTimeout(req, fallback) {
  const value = Number(req?.headers?.['x-rabi-timeout-ms']);
  return Number.isInteger(value) && value >= 1 && value <= 2147483647 ? value : fallback;
}
