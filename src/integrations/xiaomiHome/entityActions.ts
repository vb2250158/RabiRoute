import { createHash } from "node:crypto";

type JsonObject = Record<string, unknown>;
export type HomeActionSchema = {
  type?: string | string[]; properties?: Record<string, HomeActionSchema>; required?: string[];
  additionalProperties?: boolean; items?: HomeActionSchema; prefixItems?: HomeActionSchema[];
  minItems?: number; maxItems?: number; minimum?: number; maximum?: number;
  minLength?: number; maxLength?: number; enum?: unknown[]; const?: unknown; description?: string;
};
export type HomeEntityAction = {
  action: string; revision: string; name: string; description: string;
  capability: "home.entity.action@1"; argumentsSchema: HomeActionSchema;
  confirmation: "provider_acceptance"; providerSelector: JsonObject;
};
export type HomeEntityState = { entityId: string; attributes: JsonObject };
export type HomeServiceDomain = { domain: string; services: Record<string, JsonObject> };
export const HOME_ENTITY_ACTION_CAPABILITY = "home.entity.action@1";
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const values = (value: unknown): unknown[] => Array.isArray(value) ? value : value === undefined ? [] : [value];
const identifier = /^[a-z][a-z0-9_]*$/;

function matchesFilter(filter: JsonObject, state: HomeEntityState): boolean {
  const domain = state.entityId.split(".")[0];
  if (filter.domain !== undefined && !values(filter.domain).includes(domain)) return false;
  const features = Number(state.attributes.supported_features || 0);
  // HA's feature list is an OR, while each bit mask requires all of its bits.
  if (Array.isArray(filter.supported_features) && !filter.supported_features.some(value =>
    typeof value === "number" && (features & value) === value)) return false;
  for (const [name, expected] of Object.entries(object(filter.attribute))) {
    if (!values(state.attributes[name]).some(value => values(expected).includes(value))) return false;
  }
  return true;
}

function fieldSchema(name: string, field: JsonObject, state: HomeEntityState): HomeActionSchema {
  const selector = object(field.selector);
  let schema: HomeActionSchema = {};
  if (Object.hasOwn(selector, "number") || Object.hasOwn(selector, "color_temp")) {
    const config = object(selector.number ?? selector.color_temp);
    schema = { type: "number", ...(typeof config.min === "number" ? {minimum: config.min} : {}),
      ...(typeof config.max === "number" ? {maximum: config.max} : {}) };
  } else if (Object.hasOwn(selector, "boolean")) schema = {type: "boolean"};
  else if (Object.hasOwn(selector, "color_rgb")) schema = {type: "array", minItems: 3, maxItems: 3, items: {type: "integer", minimum: 0, maximum: 255}};
  else if (Object.hasOwn(selector, "select")) {
    const config = object(selector.select);
    const options = values(config.options).map(item => typeof item === "object" ? object(item).value : item);
    schema = {type: "string", maxLength: 8192, ...(options.length && config.custom_value !== true ? {enum: options} : {})};
  } else if (Object.hasOwn(selector, "state")) {
    const config = object(selector.state);
    const attribute = typeof config.attribute === "string" ? config.attribute : undefined;
    const options = state.attributes[attribute ? `${attribute}_list` : "options"]
      ?? state.attributes[attribute ? `${attribute}s` : "hvac_modes"];
    schema = {type: "string", maxLength: 8192, ...(Array.isArray(options) ? {enum: options} : {})};
  } else if (Object.hasOwn(selector, "constant")) schema = {const: object(selector.constant).value};
  else if (["text", "entity", "area", "device", "date", "datetime"].some(key => Object.hasOwn(selector, key))) {
    schema = {type: "string", maxLength: 8192};
  }
  const config = Object.values(selector)[0];
  if (object(config).multiple === true && schema.type !== "array") schema = {type: "array", maxItems: 256, items: schema};
  if (state.entityId.startsWith("number.") && name === "value") schema = {
    type: "number", ...(typeof state.attributes.min === "number" ? {minimum: state.attributes.min} : {}),
    ...(typeof state.attributes.max === "number" ? {maximum: state.attributes.max} : {})
  };
  if (state.entityId.startsWith("text.") && name === "value") schema = {
    type: "string", minLength: Number(state.attributes.min || 0), maxLength: Number(state.attributes.max ?? 8192)
  };
  if (typeof field.description === "string") schema.description = field.description;
  return schema;
}

function parametersSchema(fields: JsonObject, state: HomeEntityState): HomeActionSchema {
  const properties: Record<string, HomeActionSchema> = {};
  const required: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    const field = object(value);
    if (field.fields) {
      const nested = parametersSchema(object(field.fields), state);
      Object.assign(properties, nested.properties); required.push(...nested.required ?? []);
    } else if (identifier.test(name) && !["entity_id", "device_id", "area_id", "target"].includes(name)
      && matchesFilter(object(field.filter), state)) {
      properties[name] = fieldSchema(name, field, state);
      if (field.required === true) required.push(name);
    }
  }
  return {type: "object", properties, required, additionalProperties: false};
}

/** MIoT notify parameters are positional. Names and types come from the live entity. */
export function miotActionParameters(attributes: JsonObject): HomeActionSchema | undefined {
  if (!Object.hasOwn(attributes, "action params")) return undefined;
  const text = attributes["action params"];
  if (typeof text !== "string" || !text.startsWith("[") || !text.endsWith("]")) throw new TypeError("Invalid MIoT action parameter declaration.");
  const entries = text.slice(1, -1).trim() ? text.slice(1, -1).split(/,\s*/) : [];
  const prefixItems = entries.map(entry => {
    const match = /^(.*)\((str|int|float|bool)\)$/.exec(entry.trim());
    if (!match) throw new TypeError("Unknown MIoT action parameter type.");
    return {type: ({str: "string", int: "integer", float: "number", bool: "boolean"} as Record<string,string>)[match[2]],
      description: match[1], ...(match[2] === "str" ? {maxLength: 8192} : {})};
  });
  return {type: "object", properties: {values: {type: "array", prefixItems, minItems: entries.length, maxItems: entries.length}},
    required: ["values"], additionalProperties: false};
}

/** Derive entity actions from HA's current service/feature/field metadata, not a device-name allowlist. */
export function discoverHomeEntityActions(state: HomeEntityState, domains: HomeServiceDomain[]): HomeEntityAction[] {
  const domain = state.entityId.split(".")[0];
  const services = domains.find(item => item.domain === domain)?.services ?? {};
  const actions: HomeEntityAction[] = [];
  for (const [action, service] of Object.entries(services)) {
    if (!identifier.test(action)) continue;
    const targets = values(object(service.target).entity);
    // Services without an entity target are global operations and cannot be bound to this resource.
    if (!targets.length || !targets.some(target => matchesFilter(object(target), state))) continue;
    let parameters = parametersSchema(object(service.fields), state);
    if (domain === "notify" && action === "send_message") parameters = miotActionParameters(state.attributes) ?? parameters;
    const revision = `ha-action:${createHash("sha256").update(JSON.stringify({domain, action, parameters, target: service.target})).digest("hex").slice(0,24)}`;
    actions.push({action, revision, name: String(service.name || `${domain}.${action}`), description: String(service.description || ""),
      capability: HOME_ENTITY_ACTION_CAPABILITY, confirmation: "provider_acceptance", providerSelector: object(service.fields),
      argumentsSchema: {type: "object", properties: {action: {const: action}, actionRevision: {const: revision}, parameters},
        required: ["action", "actionRevision", "parameters"], additionalProperties: false}});
  }
  return actions;
}

export function validateHomeActionValue(value: unknown, schema: HomeActionSchema, field = "arguments", depth = 0): void {
  if (depth > 12) throw new TypeError("Action parameters are too deeply nested.");
  if (schema.const !== undefined && value !== schema.const) throw new TypeError(`Changed action contract: ${field}.`);
  if (schema.enum && !schema.enum.includes(value)) throw new TypeError(`Unsupported option: ${field}.`);
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`Expected object: ${field}.`);
    const record = value as JsonObject;
    if ((schema.required ?? []).some(key => !Object.hasOwn(record, key))) throw new TypeError(`Missing action parameter: ${field}.`);
    if (schema.additionalProperties === false && Object.keys(record).some(key => !Object.hasOwn(schema.properties ?? {}, key))) throw new TypeError(`Unknown action parameter: ${field}.`);
    for (const [key, child] of Object.entries(record)) validateHomeActionValue(child, schema.properties?.[key] ?? {}, `${field}.${key}`, depth+1);
  } else if (schema.type === "array") {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? 256)) throw new TypeError(`Invalid array: ${field}.`);
    value.forEach((child,index) => validateHomeActionValue(child, schema.prefixItems?.[index] ?? schema.items ?? {}, `${field}[${index}]`, depth+1));
  } else if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || schema.type === "integer" && !Number.isSafeInteger(value)
      || value < (schema.minimum ?? -Number.MAX_VALUE) || value > (schema.maximum ?? Number.MAX_VALUE)) throw new TypeError(`Invalid number: ${field}.`);
  } else if (schema.type === "boolean" && typeof value !== "boolean") throw new TypeError(`Expected boolean: ${field}.`);
  else if (schema.type === "string" && (typeof value !== "string" || value.length < (schema.minLength ?? 0)
    || value.length > (schema.maxLength ?? 8192) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))) throw new TypeError(`Invalid text: ${field}.`);
  // Untranslated HA selectors remain provider-validated JSON; never accept executable/non-JSON objects.
  if (!schema.type && schema.const === undefined) {
    if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return;
    if (typeof value === "string") { if(value.length>8192) throw new TypeError("Action text is too long."); return; }
    if (Array.isArray(value)) { if(value.length>256) throw new TypeError("Too many action values."); value.forEach(child=>validateHomeActionValue(child,{},field,depth+1)); }
    else if (value && typeof value === "object") {
      if(Object.keys(value).length>128) throw new TypeError("Too many action fields.");
      for(const child of Object.values(value)) validateHomeActionValue(child,{},field,depth+1);
    }
    else throw new TypeError(`Expected JSON: ${field}.`);
  }
}

export function mapHomeEntityAction(entityId: string, args: Record<string,unknown>): {domain:string; service:string; data:JsonObject} {
  validateHomeActionValue(args, {type:"object", properties:{action:{type:"string",maxLength:128},actionRevision:{type:"string",maxLength:80},parameters:{type:"object"}},
    required:["action","actionRevision","parameters"],additionalProperties:false});
  if (!identifier.test(String(args.action)) || !/^ha-action:[a-f0-9]{24}$/.test(String(args.actionRevision))) throw new TypeError("Invalid action identity.");
  const parameters = args.parameters as JsonObject;
  if (Object.keys(parameters).some(key=>["entity_id","device_id","area_id","target"].includes(key))) throw new TypeError("Action target is owned by resourceId.");
  const domain = entityId.split(".")[0];
  const data = domain === "notify" && args.action === "send_message" && Object.hasOwn(parameters,"values")
    ? {message:JSON.stringify(parameters.values)} : parameters;
  return {domain,service:String(args.action),data:{...data,entity_id:entityId}};
}
