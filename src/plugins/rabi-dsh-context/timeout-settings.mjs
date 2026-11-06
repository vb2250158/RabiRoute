let snapshot = Object.create(null);
let environmentText, environmentSnapshot = Object.create(null);
const diagnostics = new Map();
function report(source, message) {
  if (diagnostics.get(source) === message) return;
  diagnostics.set(source, message);
  process.emitWarning(`${source}: ${message}`, { code: 'RABI_TIMEOUT_OVERRIDES' });
}
function normalize(value, source) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    report(source, 'expected an object; using default timeouts. Fix or remove that setting.');
    return Object.create(null);
  }
  const accepted = Object.create(null), invalid = [];
  for (const [key, duration] of Object.entries(value)) {
    if (Number.isSafeInteger(duration) && duration >= 1 && duration <= 2147483647) accepted[key] = duration;
    else invalid.push(key);
  }
  if (invalid.length) report(source, `ignoring ${invalid.length} invalid entries (${invalid.slice(0, 5).join(', ')}); valid entries remain active. Use integer milliseconds from 1 to 2147483647.`);
  else diagnostics.delete(source);
  return accepted;
}
export function configureTimeouts(value) {
  snapshot = value === undefined ? Object.create(null) : normalize(value, 'Manager timeoutOverrides');
}
export function getTimeoutMs(key, fallback, env = process.env) {
  const raw = env.RABIROUTE_TIMEOUT_OVERRIDES || '';
  if (raw !== environmentText) {
    environmentText = raw;
    try { environmentSnapshot = normalize(JSON.parse(raw || '{}'), 'RABIROUTE_TIMEOUT_OVERRIDES'); }
    catch {
      environmentSnapshot = Object.create(null);
      report('RABIROUTE_TIMEOUT_OVERRIDES', 'invalid JSON; using default timeouts. Fix or remove that environment setting.');
    }
  }
  return snapshot[key] ?? environmentSnapshot[key] ?? fallback;
}
