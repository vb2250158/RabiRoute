import { createHash } from 'node:crypto';
import data from './assets/computer-settings.json' with { type: 'json' };
function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]));
  return value;
}
/** Package data owns the definition; the stable host factory only interprets it. */
export function createComputerSettingsDefinition(factory) {
  return factory(data, createHash('sha256').update(JSON.stringify(ordered(data))).digest('hex'));
}
