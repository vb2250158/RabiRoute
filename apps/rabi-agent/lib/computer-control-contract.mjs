import {COMPUTER_SETTINGS_DEFINITION,COMPUTER_SETTINGS_DEFINITION_DIGEST} from './computer-settings-definition.mjs';
/** Shared settings and action facts. Runtime state remains with the target ComputerService. */
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const object = value => value && typeof value === 'object' && !Array.isArray(value);




/** UI annotations stay in the returned form schema; executable API schemas use standard JSON Schema keywords. */
function validationSchema(value) {
  if (Array.isArray(value)) return value.map(validationSchema);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'unit' && key !== 'advanced').map(([key, child]) => [key, validationSchema(child)]));
}

function defaults(schema) { if (Object.hasOwn(schema, 'default')) return schema.default; if (schema.properties) return Object.fromEntries(Object.entries(schema.properties).map(([k,v]) => [k, defaults(v)])); }

/** Merge at the original storage owner. Unknown saved extension fields survive known-field updates. */
function merge(base, patch) { const next = { ...base }; for (const [key, value] of Object.entries(patch)) Object.defineProperty(next, key, { value: object(value) && object(base?.[key]) ? merge(base[key], value) : structuredClone(value), writable: true, enumerable: true, configurable: true }); return next; }
function validate(value, schema, field) {
  if (schema.anyOf) { if (value === null && schema.anyOf.some(s => s.type === 'null')) return; return validate(value, schema.anyOf.find(s => s.type !== 'null'), field); }
  if (schema.type === 'object') { if (!object(value)) throw new TypeError(`${field} must be an object.`); for (const [key, entry] of Object.entries(value)) if (Object.hasOwn(schema.properties ?? {}, key)) validate(entry, schema.properties[key], `${field}.${key}`); return; }
  if (typeof value !== schema.type || schema.type === 'number' && (!Number.isFinite(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) || schema.enum && !schema.enum.includes(value) || schema.minLength && value.length < schema.minLength) throw new TypeError(`Invalid ${field}.`);
}


/** These are the current instanceManagement/AgentThreadRequest actions, not a capability permission registry. */
export const INSTANCE_AGENT_OPERATIONS = freeze({ tasks: {newWork:true}, prepared_delivery:{newWork:true}, reconcile_prepared_delivery:{readOnly:true,recovery:true} });
export const INSTANCE_AGENT_THREAD_ACTIONS = freeze({ ds_bot_catalog:{readOnly:true,recovery:true}, ds_bot_reconcile:{readOnly:true,recovery:true}, ds_bot_deliver:{newWork:true,reconcileAction:"ds_bot_reconcile"}, list:{readOnly:true,recovery:true}, read:{readOnly:true,recovery:true}, creation_status:{readOnly:true,recovery:true},
  create:{newWork:true}, create_metadata:{newWork:true}, send:{newWork:true}, open:{}, rename:{}, resolve:{newWorkUnlessFalse:'createIfMissing'} });
export function instanceAgentActionDefinition(operation, params = {}) {
  if (operation !== 'threads') return INSTANCE_AGENT_OPERATIONS[operation];
  const entry = INSTANCE_AGENT_THREAD_ACTIONS[params.action];
  if (entry?.newWorkUnlessFalse) return params[entry.newWorkUnlessFalse] === false ? {readOnly:true,recovery:true} : {newWork:true};
  return entry;
}
export const TERMINAL_ACTIONS = freeze({ list: {readOnly:true,recovery:true}, get: {readOnly:true,recovery:true}, close: {recovery:true}, open:{}, input:{}, resize:{} });
export function terminalActionDefinition(action) { return TERMINAL_ACTIONS[action]; }



/** Keep untouched fields opaque; validate only dependencies declared by this action. */


/** Feature admission reads only its actual enabled flags, not unrelated rendering/tracking parameters. */







export function createComputerSettingsDefinition(data, digest) {
  if (!object(data) || data.schemaVersion !== 1 || !object(data.features) || !object(data.schema) || !object(data.actions)) throw new TypeError('Invalid computer settings definition root.');
  const snapshot = freeze(structuredClone(data));
  const COMPUTER_FEATURES = snapshot.features, computerSettingsSchema = snapshot.schema, COMPUTER_ACTIONS = snapshot.actions;
  const computerSettingsValidationSchema = freeze(validationSchema(computerSettingsSchema));
  const DEFAULT_COMPUTER_SETTINGS = freeze(defaults(computerSettingsSchema));
function normalizeComputerSettings(value, enabled) {
  if (value !== undefined && !object(value)) throw new TypeError('computerSettings must be an object.');
  const saved = object(value) ? value : {};
  const next = merge(DEFAULT_COMPUTER_SETTINGS, saved);
  if (enabled !== undefined) next.enabled = enabled;
  validate(next, computerSettingsSchema, 'computerSettings'); return next;
}
function computerActionDefinition(action) { return COMPUTER_ACTIONS[action]; }
function normalizeComputerSettingsForAction(value, action, enabled, input = {}) {
  if (value !== undefined && !object(value)) throw new TypeError('computerSettings must be an object.');
  const next = merge(DEFAULT_COMPUTER_SETTINGS, value ?? {});
  if (enabled !== undefined) next.enabled = enabled;
  const entry = computerActionDefinition(action);
  for (const [name,path] of Object.entries(entry?.inputSettings ?? {})) if (Object.hasOwn(input,name)) {
    const keys=String(path).split(".");let target=next;
    for(const key of keys.slice(0,-1)){if(!object(target[key]))throw new TypeError("Invalid computerSettings."+keys.slice(0,-1).join("."));target=target[key];}
    target[keys.at(-1)]=structuredClone(input[name]);
  }
  const feature = action === 'terminal' ? 'terminal' : entry?.feature;
  if (feature) projectComputerFeaturePolicy(next, feature);
  const paths = action === 'settings.update'
    ? ['enabled', 'features.input', 'features.annotation', 'features.observation', 'annotation.dynamicEnabled', 'control']
    : entry?.settingsPaths ?? [];
  for (const pathname of paths) {
    let target = next, schema = computerSettingsSchema;
    for (const key of pathname.split('.')) { target = target?.[key]; schema = schema.properties[key]; }
    validate(target, schema, 'computerSettings.' + pathname);
  }
  return next;
}
function projectComputerFeaturePolicy(value, feature, legacyEnabled) {
  if (value !== undefined && !object(value)) throw new TypeError('computerSettings must be an object.');
  const saved = value ?? {};
  const invalid = field => { throw Object.assign(new TypeError(`Invalid computerSettings.${field}.`), {code:'COMPUTER_SETTINGS_INVALID',field}); };
  if (saved.enabled !== undefined && typeof saved.enabled !== 'boolean') invalid('enabled');
  if (legacyEnabled !== undefined && typeof legacyEnabled !== 'boolean') invalid('enabled');
  if (saved.features !== undefined && !object(saved.features)) invalid('features');
  const own = saved.features?.[feature];
  if (own !== undefined && typeof own !== 'boolean') invalid('features.' + feature);
  return { enabled: legacyEnabled ?? saved.enabled ?? DEFAULT_COMPUTER_SETTINGS.enabled, feature, allowed: own ?? DEFAULT_COMPUTER_SETTINGS.features[feature] };
}
function assertComputerFeaturePolicyEnabled(policy, instanceId) {
  if (!policy.enabled || !policy.allowed) throw Object.assign(new Error(`Computer ${instanceId ?? ''} ${!policy.enabled ? 'enabled' : 'features.' + policy.feature} is disabled. Change RabiLink → 电脑控制.`), {code:'COMPUTER_FEATURE_DISABLED',feature:policy.feature,field:!policy.enabled?'enabled':'features.'+policy.feature,instanceId});
}
function assertComputerFeatureEnabled(settings, feature, instanceId) {
  assertComputerFeaturePolicyEnabled(projectComputerFeaturePolicy(settings,feature),instanceId);
}
function assertComputerActionEnabled(settings, action, instanceId) {
  const entry = computerActionDefinition(action); if (!entry) throw new Error('Unknown computer action. Read the current computer operation schema.');
  if (entry.recovery) return;
  assertComputerFeatureEnabled(settings, entry.feature, instanceId);
  const annotation = object(settings) ? settings.annotation : undefined;
  if (entry.dynamic && annotation !== undefined && !object(annotation)) throw new TypeError('computerSettings.annotation must be an object.');
  const dynamicEnabled = annotation?.dynamicEnabled ?? DEFAULT_COMPUTER_SETTINGS.annotation.dynamicEnabled;
  if (entry.dynamic) validate(dynamicEnabled,computerSettingsSchema.properties.annotation.properties.dynamicEnabled,'computerSettings.annotation.dynamicEnabled');
  if (entry.dynamic && !dynamicEnabled) throw Object.assign(new Error('Dynamic annotation is disabled. Change RabiLink → 电脑控制 → 屏幕标注.'), { code: 'COMPUTER_DYNAMIC_DISABLED', field: 'annotation.dynamicEnabled', instanceId });
}
function isComputerReadOnlyAction(action) { return computerActionDefinition(action)?.readOnly === true; }
  function diagnose(value) {
    const problems = [];
    const walk = (item, schema, field) => {
      if (schema.type === 'object' && object(item)) {
        for (const [key, child] of Object.entries(schema.properties ?? {})) if (Object.hasOwn(item,key)) walk(item[key],child,field+'.'+key);
      } else { try { validate(item,schema,field); } catch(error) { problems.push({field,message:error.message}); } }
    };
    walk(value,computerSettingsSchema,'computerSettings');
    return problems;
  }
  function materialize(value, enabled) {
    if (value !== undefined && !object(value)) return value;
    const next = merge(DEFAULT_COMPUTER_SETTINGS, value ?? {});
    if (enabled !== undefined) next.enabled = enabled;
    return freeze(next);
  }
  function selectPatch(value, paths) {
    if (value !== undefined && !object(value)) throw new TypeError('computerSettings must be an object.');
    const effective = materialize(value);
    const patch = {};
    for (const pathname of paths) {
      const keys = pathname.split('.');
      let schema = computerSettingsSchema;
      let item = effective;
      for (const key of keys) {
        schema = schema.properties?.[key];
        if (!schema) throw new TypeError('Unknown settings path ' + pathname);
        item = item?.[key];
      }
      validate(item, schema, 'computerSettings.' + pathname);
      let target = patch;
      for (const key of keys.slice(0, -1)) target = target[key] ??= {};
      target[keys.at(-1)] = structuredClone(item);
    }
    return patch;
  }
  function patchRaw(current, patch, restorePaths = []) {
    if (!object(patch)) throw new TypeError('Computer settings patch must be an object.');
    validate(patch, computerSettingsSchema, 'computerSettings');
    if (!Array.isArray(restorePaths)) throw new TypeError('Computer settings reset paths must be an array.');
    const paths = restorePaths.map(pathname => {
      if (typeof pathname !== 'string' || !pathname) throw new TypeError('A defined settings path is required. Read the current computer-settings schema.');
      const keys = pathname.split('.'); let schema = computerSettingsSchema;
      for (const key of keys) { if (!object(schema.properties) || !Object.hasOwn(schema.properties,key)) throw Object.assign(new TypeError('Unknown settings path: '+pathname+'. Read the current computer-settings schema.'),{code:'COMPUTER_SETTINGS_PATH_INVALID',field:pathname,status:400}); schema = schema.properties[key]; }
      return keys;
    });
    const replaceMalformed = current !== undefined && !object(current);
    const definedPaths = [];
    const collect = (schema, prefix) => { if (schema.type === "object" && schema.properties) { for (const [key, child] of Object.entries(schema.properties)) collect(child, [...prefix,key]); } else definedPaths.push(prefix); };
    collect(computerSettingsSchema, []);
    const resetsAll = definedPaths.every(path => paths.some(keys => keys.every((key,index) => path[index] === key)));
    if (replaceMalformed && !resetsAll) throw new TypeError('computerSettings must be an object. Explicitly restore all defined settings to repair this malformed record.');
    const next = merge(replaceMalformed ? {} : structuredClone(current ?? {}),patch);
    for (const keys of paths) { let target = next; for (const key of keys.slice(0,-1)) { if (!object(target[key])) { target=undefined;break; } target=target[key]; } if(target)delete target[keys.at(-1)]; }
    return next;
  }
  return freeze({data:snapshot,digest,features:COMPUTER_FEATURES,schema:computerSettingsSchema,validationSchema:computerSettingsValidationSchema,defaults:DEFAULT_COMPUTER_SETTINGS,actions:COMPUTER_ACTIONS,materialize,diagnose,selectPatch,patchRaw,normalize:normalizeComputerSettings,normalizeForAction:normalizeComputerSettingsForAction,projectFeaturePolicy:projectComputerFeaturePolicy,assertFeaturePolicy:assertComputerFeaturePolicyEnabled,assertFeature:assertComputerFeatureEnabled,assertAction:assertComputerActionEnabled,actionDefinition:computerActionDefinition,isReadOnlyAction:isComputerReadOnlyAction});
}
export const BOOTSTRAP_COMPUTER_SETTINGS_DEFINITION = createComputerSettingsDefinition(COMPUTER_SETTINGS_DEFINITION,COMPUTER_SETTINGS_DEFINITION_DIGEST);
export const COMPUTER_FEATURES = BOOTSTRAP_COMPUTER_SETTINGS_DEFINITION.features;
export const computerSettingsSchema = BOOTSTRAP_COMPUTER_SETTINGS_DEFINITION.schema;
export const computerSettingsValidationSchema = BOOTSTRAP_COMPUTER_SETTINGS_DEFINITION.validationSchema;
export const DEFAULT_COMPUTER_SETTINGS = BOOTSTRAP_COMPUTER_SETTINGS_DEFINITION.defaults;
export const COMPUTER_ACTIONS = BOOTSTRAP_COMPUTER_SETTINGS_DEFINITION.actions;
export const normalizeComputerSettings = (...args) => BOOTSTRAP_COMPUTER_SETTINGS_DEFINITION.normalize(...args);
export const patchComputerSettings = (current,patch) => normalizeComputerSettings(BOOTSTRAP_COMPUTER_SETTINGS_DEFINITION.patchRaw(current,patch));
export const computerActionDefinition = action => BOOTSTRAP_COMPUTER_SETTINGS_DEFINITION.actionDefinition(action);
export const normalizeComputerSettingsForAction = (...args) => BOOTSTRAP_COMPUTER_SETTINGS_DEFINITION.normalizeForAction(...args);
export const projectComputerFeaturePolicy = (...args) => BOOTSTRAP_COMPUTER_SETTINGS_DEFINITION.projectFeaturePolicy(...args);
export const assertComputerFeaturePolicyEnabled = (...args) => BOOTSTRAP_COMPUTER_SETTINGS_DEFINITION.assertFeaturePolicy(...args);
export const assertComputerFeatureEnabled = (...args) => BOOTSTRAP_COMPUTER_SETTINGS_DEFINITION.assertFeature(...args);
export const assertComputerActionEnabled = (...args) => BOOTSTRAP_COMPUTER_SETTINGS_DEFINITION.assertAction(...args);
export const isComputerReadOnlyAction = action => BOOTSTRAP_COMPUTER_SETTINGS_DEFINITION.isReadOnlyAction(action);
