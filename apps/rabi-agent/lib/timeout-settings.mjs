/** A per-connection snapshot of the Manager's settings, never shared across targets. */
export function createTimeoutSettings(initial = {}) {
  let overrides = checked(initial);
  return {
    get(key, fallback) { return overrides[key] ?? fallback; },
    adopt(meta) {
      // Older Managers publish no settings. Clear any previous generation's values.
      overrides = checked(meta?.timeoutOverrides ?? {});
    },
    snapshot() { return { ...overrides }; }
  };
}

function checked(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    console.warn("Rabi Agent timeout settings: invalid snapshot; using default timeouts for this connection.");
    return Object.create(null);
  }
  const result = Object.create(null);
  for (const [key, ms] of Object.entries(value)) {
    if (!Number.isSafeInteger(ms) || ms < 1 || ms > 2_147_483_647) {
      console.warn(`Rabi Agent timeout settings: ignored invalid duration for ${JSON.stringify(key)}; using its default.`);
      continue;
    }
    result[key] = ms;
  }
  return result;
}
