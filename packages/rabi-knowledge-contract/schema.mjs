// Pure shared schema: no Manager access, transport, credentials or business state.
const text = { type: 'string', maxLength: 16000 };
const short = { type: 'string', minLength: 1, maxLength: 512 };
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const source = object({ kind: short, summary: text });
const keywords = { type: 'array', items: short, minItems: 1, maxItems: 100 };
const step = object({ id: short, title: short, detail: text, waitingFor: text, blockedBy: text, startedAt: short, completedAt: short }, ['id', 'title']);
const common = { title: short, focus: short, keywords, source };
const plan = { ...common, activationStatus: { enum: ['进行中', '已完成'] }, markerStatus: short, importance: { type: 'integer', minimum: 0, maximum: 4 }, urgency: { type: 'integer', minimum: 0, maximum: 4 }, kind: short, currentStep: text, currentStepId: short, nextAction: text, waitingFor: text, blockedBy: text, dueAt: short, steps: { type: 'array', items: step, minItems: 1, maxItems: 100 } };
const memory = { ...common, content: text };
const role = { roleId: short };
const page = { query: text, cursor: text, limit: { type: 'integer', minimum: 1, maximum: 100 } };
export const definitions = {
  knowledge_search: object({ ...role, ...page, kind: { enum: ['plan', 'recent', 'consolidated'] }, mode: { enum: ['keywords', 'fulltext'] }, archived: { type: 'boolean' } }, ['roleId']),
  plan_list: object({ ...role, ...page }, ['roleId']),
  plan_get: object({ ...role, id: short }, ['roleId', 'id']),
  plan_statuses: object(role, ['roleId']),
  memory_list: object({ ...role, ...page, kind: { enum: ['recent', 'consolidated', 'archived'] } }, ['roleId', 'kind']),
  memory_get: object({ ...role, id: short, kind: { enum: ['recent', 'consolidated'] }, idempotencyKey: short }, ['roleId', 'id', 'kind']),
  plan_create: object({ ...role, idempotencyKey: short, body: object(plan, ['title', 'focus', 'keywords', 'steps', 'activationStatus', 'markerStatus']) }, ['roleId', 'idempotencyKey', 'body']),
  plan_update: object({ ...role, id: short, idempotencyKey: short, etag: short, body: object(plan) }, ['roleId', 'id', 'idempotencyKey', 'etag', 'body']),
  recent_memory_create: object({ ...role, idempotencyKey: short, body: object(memory, ['title', 'focus', 'keywords', 'content']) }, ['roleId', 'idempotencyKey', 'body']),
  recent_memory_update: object({ ...role, id: short, idempotencyKey: short, etag: short, body: object(memory) }, ['roleId', 'id', 'idempotencyKey', 'etag', 'body'])
};
export function validate(value, schema, label = 'arguments') {
  if (schema.enum) { if (!schema.enum.includes(value)) throw new TypeError(`Invalid ${label}.`); return; }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`Invalid ${label}.`);
    for (const key of Object.keys(value)) { if (!Object.hasOwn(schema.properties, key)) throw new TypeError(`Unknown field in ${label}.`); validate(value[key], schema.properties[key], `${label}.${key}`); }
    for (const key of schema.required) if (!Object.hasOwn(value, key)) throw new TypeError(`Missing ${label}.${key}.`);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems || 0) || value.length > schema.maxItems) throw new TypeError(`Invalid ${label}.`);
    value.forEach(item => validate(item, schema.items, label));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length > schema.maxLength || (schema.minLength && !value.trim())) throw new TypeError(`Invalid ${label}.`);
  } else if (schema.type === 'integer') {
    if (!Number.isInteger(value) || value < schema.minimum || value > schema.maximum) throw new TypeError(`Invalid ${label}.`);
  } else if (typeof value !== schema.type) throw new TypeError(`Invalid ${label}.`);
}
export function validateKnowledgeArguments(name, args) {
  if (!Object.hasOwn(definitions, name)) throw new TypeError('Unknown knowledge operation.');
  validate(args, definitions[name]);
}
