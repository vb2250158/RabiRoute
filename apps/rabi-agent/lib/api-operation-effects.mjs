/** Public effect facts are presentation and outcome classification, never authorization. */
export function operationEffectMode(contract, input) {
  const effects = contract?.effects;
  const selector = effects?.request;
  let value = input;
  if (selector && Array.isArray(selector.bodyPath)) {
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) value = new TextDecoder().decode(value);
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch { value = undefined; } }
    for (const key of selector.bodyPath) {
      value = value && typeof value === 'object' && Object.hasOwn(value, key) ? value[key] : undefined;
    }
    if (typeof value === 'string' && Object.hasOwn(selector.modes ?? {}, value)) return selector.modes[value];
  }
  return effects?.mode ?? '';
}
export function operationIsReadOnly(contract, method = contract.method, body) {
  const mode = operationEffectMode(contract, body);
  const declaredRead = /(?:^|-)read$/.test(mode) && !/touch|mutation|write/.test(mode);
  return declaredRead && (contract.method !== '*' || ['GET', 'HEAD', 'OPTIONS'].includes(method));
}
// Only the catalog preparing the immutable operation attaches this fact. JSON
// request options cannot claim a read effect for a mutation or enable replay.
const selectedEffects = new WeakMap();
export function markOperationEffect(options, contract, method) {
  if (contract?.effects?.request && options.body && typeof options.body === 'object') {
    options = { ...options, body: JSON.stringify(options.body) };
  }
  if (contract?.effects?.request && options.bodyBytes !== undefined) {
    options = { ...options, bodyBytes: options.bodyBytes instanceof ArrayBuffer ? options.bodyBytes.slice(0) : Uint8Array.from(options.bodyBytes) };
  }
  selectedEffects.set(options, operationIsReadOnly(contract, method, options.body ?? options.bodyText ?? options.bodyBytes));
  return options;
}
export function selectedOperationReadOnly(options) { return selectedEffects.get(options); }
export function copyOperationEffect(source, target) {
  if (selectedEffects.has(source)) selectedEffects.set(target, selectedEffects.get(source));
  return target;
}
