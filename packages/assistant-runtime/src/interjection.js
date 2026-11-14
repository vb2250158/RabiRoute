import { checkCurrent } from './assert-current.js';

const failure = code => Object.assign(new Error(code), { code });

/** Snapshot an adapter-owned input. This module never reserves or persists work. */
export function captureInterjection(value, options = {}) {
  if (!value || ['id', 'scope', 'text'].some(key => typeof value[key] !== 'string'
      || !value[key].trim() || value[key].length > (key === 'text' ? 16000 : 512))) {
    throw failure('ASSISTANT_INTERJECTION_INVALID');
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)
      || (options.assertCurrent !== undefined && typeof options.assertCurrent !== 'function')) {
    throw failure('ASSISTANT_RUN_OPTIONS_INVALID');
  }
  return { input: Object.freeze({ id: value.id, scope: value.scope, text: value.text }), assertCurrent: options.assertCurrent };
}

export function interjectionResult(input, status, modelInvoked, details = {}) {
  return Object.freeze({ input, status, modelInvoked, toolDispatched: false, ...details });
}

export function unavailableInterjection(value, options, code) {
  const entry = captureInterjection(value, options);
  try { checkCurrent(entry.assertCurrent); }
  catch (error) { code = error?.code || 'ASSISTANT_INTERJECTION_BINDING_STALE'; }
  return Promise.resolve(interjectionResult(entry.input, 'unavailable', false, { code }));
}
