/** Milliseconds. An absent key preserves the owning component's existing default. */
export type TimeoutOverrides = Record<string, number>;
export type TimeoutCatalogEntry = { key: string; defaultMs: number; label: string; scope: string; effect: string };

let overrides: Readonly<TimeoutOverrides> = Object.freeze({});
const registeredCatalog = new Map<string, Map<symbol, TimeoutCatalogEntry>>();

/** Dynamic plugins publish their actual operation deadlines for the settings UI. */
export function registerTimeoutCatalog(entries: readonly TimeoutCatalogEntry[]): () => void {
  const token = Symbol("timeout-catalog-registration");
  for (const entry of entries) {
    let registrations = registeredCatalog.get(entry.key);
    if (!registrations) registeredCatalog.set(entry.key, registrations = new Map());
    registrations.set(token, { ...entry });
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const entry of entries) {
      const registrations = registeredCatalog.get(entry.key);
      registrations?.delete(token);
      if (!registrations?.size) registeredCatalog.delete(entry.key);
    }
  };
}

export function readRegisteredTimeoutCatalog(): TimeoutCatalogEntry[] {
  return [...registeredCatalog.values()].map(registrations => ({ ...[...registrations.values()].at(-1)! }));
}

export function validateTimeoutOverrides(value: unknown): TimeoutOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("timeoutOverrides must be an object.");
  const result: TimeoutOverrides = {};
  for (const [key, ms] of Object.entries(value)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(key) || !Number.isInteger(ms) || ms < 1 || ms > 2_147_483_647) {
      throw new Error(`timeoutOverrides.${key}: expected integer milliseconds from 1 to 2147483647.`);
    }
    Object.defineProperty(result, key, { value: ms, enumerable: true, writable: true, configurable: true });
  }
  return result;
}

/** Publish only after the configuration owner has committed the complete snapshot. */
export function configureTimeouts(value: TimeoutOverrides): void {
  overrides = Object.freeze(validateTimeoutOverrides(value));
  if (typeof process !== "undefined" && process.env) {
    process.env.RABIROUTE_TIMEOUT_OVERRIDES = JSON.stringify(overrides);
  }
}

export function readTimeoutOverrides(): TimeoutOverrides { return { ...overrides }; }

/** Capture at operation admission; changing settings must not restart in-flight timers. */
export function getTimeoutMs(key: string, fallback: number): number {
  return Object.hasOwn(overrides, key) ? overrides[key]! : fallback;
}

// Child processes receive a snapshot from their launcher, never the parent's data path.
if (typeof process !== "undefined" && process.env?.RABIROUTE_TIMEOUT_OVERRIDES) {
  // Environment is a consumer snapshot. One invalid optional value cannot disable
  // the kernel; writes through configureTimeouts still validate the whole request.
  let value: unknown;
  try { value = JSON.parse(process.env.RABIROUTE_TIMEOUT_OVERRIDES); }
  catch { process.emitWarning("Invalid RABIROUTE_TIMEOUT_OVERRIDES JSON was ignored; component defaults remain active."); }
  const accepted: TimeoutOverrides = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    let invalid = false;
    for (const [key, ms] of Object.entries(value)) {
      try { Object.assign(accepted, validateTimeoutOverrides({ [key]: ms })); }
      catch { invalid = true; }
    }
    if (invalid) process.emitWarning("Invalid RABIROUTE_TIMEOUT_OVERRIDES entries were ignored; valid entries remain active.");
  } else if (value !== undefined) process.emitWarning("RABIROUTE_TIMEOUT_OVERRIDES must be an object; component defaults remain active.");
  configureTimeouts(accepted);
}
