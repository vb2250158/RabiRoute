import { appendAdapterLogToDir } from "@rabiroute/host-api/history";
import type { ApiOperationDefinition } from "@rabiroute/host-api/manager/apiOperationContract";

type Selector = Readonly<{ resolved: boolean; value?: unknown }>;
export type NapcatEventManifest = Readonly<{
  source: { version: string; bundleSha256: string };
  events: readonly Readonly<{ className: string; line: number; instantiated: boolean;
    fields: readonly string[]; selectors: Readonly<Record<string, Selector | undefined>> }>[];
}>;
export type NapcatEventSource = Readonly<{ routeId: string; instanceId: string; botUserId: string }>;
export type NapcatEventRecord = Readonly<{
  version: 1; source: NapcatEventSource; kind: string; eventClasses: readonly string[];
  fields: Readonly<Record<string, string | number | boolean | Record<string, boolean>>>;
  requestFlagPresent?: boolean;
}>;

const selectorNames = ["post_type", "message_type", "notice_type", "request_type", "meta_event_type", "sub_type"] as const;
const identityNames = ["self_id", "group_id", "user_id", "operator_id", "sender_id", "target_id", "peer_id", "message_id", "message_seq"];
const numberNames = ["time", "duration", "interval", "times", "busi_id"];
const textNames = ["comment", "card_new", "card_old", "name_new", "title", "operator_nick", "status_text"];
const identifier = /^[a-zA-Z0-9_-]{1,64}$/;
const messageId = /^-?\d{1,20}$/;

/** This literal is present in the installed class constructor, whose inferred selector was unresolved. */
function selectorsFor(row: NapcatEventManifest["events"][number]): Readonly<Record<string, Selector | undefined>> {
  return row.className === "OB11OnlineFileReceiveEvent"
    ? { ...row.selectors, notice_type: { resolved: true, value: "online_file_receive" }, sub_type: { resolved: true, value: "cancel" } }
    : row.selectors;
}

export function napcatApiEventCatalog(manifest: NapcatEventManifest) {
  return { source: manifest.source, events: manifest.events.filter(row => row.instantiated).map(row => ({
    className: row.className, sourceLine: row.line, selectors: selectorsFor(row), fields: row.fields,
    archive: "Existing napcat adapter log, typed_event record", automation: "No automatic forwarding for notice, request, meta_event or message_sent"
  })), message: { postTypes: ["message", "message_sent"], messageTypes: ["group", "private"],
    archive: "Typed metadata plus existing group/private message history for inbound message only", automation: "Existing inbound message rules remain authoritative" },
  baseClassesExcluded: manifest.events.filter(row => !row.instantiated).map(row => row.className) };
}

/** Project only declared metadata. Raw event data, request flags, URLs, local paths and opaque payloads stay with their original owner. */
export function projectNapcatApiEvent(manifest: NapcatEventManifest, source: NapcatEventSource, input: unknown): NapcatEventRecord | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const event = input as Record<string, unknown>;
  if (!source.routeId || !source.instanceId || !/^[1-9]\d{0,15}$/.test(source.botUserId)
    || String(event.self_id ?? "") !== source.botUserId) return;
  const message = ["message", "message_sent"].includes(String(event.post_type)) && ["group", "private"].includes(String(event.message_type));
  const matches = message ? [] : manifest.events.filter(row => row.instantiated && Object.entries(selectorsFor(row)).every(([key, selector]) =>
    !selector?.resolved || selector.value === event[key]) && (!row.fields.includes("group_id") || event.group_id !== undefined)
    && (!row.className.startsWith("OB11Friend") || event.group_id === undefined));
  if (!message && !matches.length) return;
  const allowed = new Set(message ? [...selectorNames, ...identityNames, "time"] : matches.flatMap(row => [...row.fields]));
  const fields: Record<string, string | number | boolean | Record<string, boolean>> = Object.create(null);
  for (const name of selectorNames) if (allowed.has(name) && typeof event[name] === "string" && identifier.test(event[name])) fields[name] = event[name];
  for (const name of identityNames) if (allowed.has(name) && messageId.test(String(event[name] ?? ""))) fields[name] = String(event[name]);
  for (const name of numberNames) if (allowed.has(name) && typeof event[name] === "number" && Number.isFinite(event[name])) fields[name] = event[name];
  for (const name of textNames) if (allowed.has(name) && typeof event[name] === "string") fields[name] = event[name].slice(0, 2000);
  if (allowed.has("is_add") && typeof event.is_add === "boolean") fields.is_add = event.is_add;
  if (allowed.has("status") && event.status && typeof event.status === "object") {
    const status = event.status as Record<string, unknown>;
    fields.status = Object.fromEntries(["online", "good"].filter(key => typeof status[key] === "boolean").map(key => [key, status[key] as boolean]));
  }
  return { version: 1, source: { ...source }, kind: selectorNames.map(name => fields[name]).filter(Boolean).join("."),
    eventClasses: message ? ["OneBotMessageProjection"] : matches.map(row => row.className), fields: { ...fields },
    ...(allowed.has("flag") ? { requestFlagPresent: typeof event.flag === "string" && event.flag.length > 0 } : {}) };
}

/** Use the existing adapter-history owner and its data mutation audit; this creates no second ledger. */
export function appendNapcatApiEvent(manifest: NapcatEventManifest, source: NapcatEventSource, input: unknown, dataDir: string): NapcatEventRecord | undefined {
  const record = projectNapcatApiEvent(manifest, source, input);
  if (record) appendAdapterLogToDir("napcat", { event: "typed_event", instanceId: source.instanceId, data: record }, dataDir);
  return record;
}

export function createNapcatApiEventCatalogOperation(manifest: NapcatEventManifest): ApiOperationDefinition {
  const empty = { type: "object", additionalProperties: false };
  return { contract: {
    operationId: "agent.qq.onebot.events.describe", contractVersion: "1.0.0", method: "GET", pathTemplate: "/api/agent/qq/onebot-event-contracts",
    description: "Describe versioned instantiated OneBot event classes, message projections and their existing ingress/archive boundary.", exposure: "public", transport: "http",
    request: { path: empty, query: empty, headers: { type: "object" }, body: { kind: "none" } },
    responses: { "200": { mediaType: "application/json", schema: { type: "object", required: ["code", "data"], properties: { code: { const: 0 }, data: { type: "object" } } } } },
    effects: { mode: "read", description: "Static event declarations only. No provider or account request." },
    recovery: { strategy: "none", description: "Static metadata read." }, validators: []
  }, discovery: { title: "QQ event contracts", summary: "Versioned event selectors, typed archive and original message-only automation boundary.",
    keywords: ["NapCat", "OneBot", "events", "notice", "request"], category: { id: "qq-onebot", title: "QQ / NapCat" } },
  handler: () => ({ status: 200, body: { code: 0, data: napcatApiEventCatalog(manifest) } }) };
}
