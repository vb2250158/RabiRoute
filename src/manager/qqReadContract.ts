import { freezeApiData, type ApiOperationContract, type ApiSchema } from "./apiOperationContract.js";
import { QQ_MEDIA_MAX_BYTES, qqMessageMedia, qqMessageText, type QqMessage } from "./qqMessageMedia.js";
import { qqReadSettings } from "../shared/qqReadSettings.js";

export const QQ_READ_LIMITS = Object.freeze({ routeIdChars: 256, historyDefault: 50, historyMax: 100, fallbackCount: 10,
  get concurrency() { return qqReadSettings.readConcurrency; }, get timeoutMs() { return qqReadSettings.readTimeoutMs; }, get mediaTimeoutMs() { return qqReadSettings.mediaTimeoutMs; } });
export const QQ_READ_KINDS = ["group", "private"] as const;
export const QQ_MESSAGE_ID_PATTERN = /^-?\d{1,20}$/;
export const QQ_ATTACHMENT_INDEX_PATTERN = /^\d{1,9}$/;
export const QQ_TARGET_ID_PATTERN = /^[1-9]\d{0,15}$/;
export type QqReadSelection = { routeId: string; kind: typeof QQ_READ_KINDS[number]; target: string };
export type QqReadTarget = { kind: "history" } | { kind: "message"; messageId: string } | { kind: "attachment"; messageId: string; index: number };
const sharedQuery = { routeId: { type: "string", minLength: 1, maxLength: QQ_READ_LIMITS.routeIdChars },
  kind: { enum: QQ_READ_KINDS }, target: { type: "string", pattern: QQ_TARGET_ID_PATTERN.source } } as const;
export const QQ_MESSAGE_QUERY_SCHEMA = freezeApiData({ type: "object", required: Object.keys(sharedQuery), properties: sharedQuery, additionalProperties: false } as const);
export const QQ_HISTORY_QUERY_SCHEMA = freezeApiData({ ...QQ_MESSAGE_QUERY_SCHEMA, properties: { ...sharedQuery,
  cursor: { type: "string", pattern: QQ_MESSAGE_ID_PATTERN.source },
  limit: { type: "string", minLength: 1, description: `Existing server Number(value) normalization; a finite integer from 1 to ${QQ_READ_LIMITS.historyMax}.` }
} } as const);
const text = { type: "string" } as const;
const attachment = { type: "object", required: ["index", "kind", "name", "contentUrl"], additionalProperties: false,
  properties: { index: { type: "integer", minimum: 0 }, kind: text, name: text, contentUrl: text } } as const;
type ProjectionField = { schema: ApiSchema; optional?: boolean; read(row: QqMessage, selection: QqReadSelection): unknown };
const projection = freezeApiData<Readonly<Record<string, ProjectionField>>>({
  messageId: { schema: { type: "string", pattern: QQ_MESSAGE_ID_PATTERN.source }, read: row => String(row.message_id) },
  time: { schema: true, optional: true, read: row => row.time },
  kind: { schema: { enum: QQ_READ_KINDS }, read: (_row, selection) => selection.kind },
  target: { schema: { type: "string", pattern: QQ_TARGET_ID_PATTERN.source }, read: (_row, selection) => selection.target },
  sender: { schema: text, read: row => String(row.sender?.user_id ?? row.user_id ?? "") },
  senderName: { schema: true, optional: true, read: row => row.sender?.card || row.sender?.nickname },
  text: { schema: text, read: row => qqMessageText(row) },
  attachments: { schema: { type: "array", items: attachment }, read: (row, selection) => qqMessageMedia(row.message ?? row.raw_message).map((media, index) => ({
    index, kind: media.kind, name: media.name,
    contentUrl: `/api/agent/qq/messages/${encodeURIComponent(String(row.message_id))}/attachments/${index}?${new URLSearchParams(selection)}`
  })) }
});
export function projectPublicQqMessage(row: QqMessage, selection: QqReadSelection): Record<string, unknown> {
  return Object.fromEntries(Object.entries(projection).map(([name, field]) => [name, field.read(row, selection)]));
}
const messageProperties = Object.fromEntries(Object.entries(projection).map(([name, field]) => [name, field.schema]));
const messageRequired = Object.entries(projection).filter(([, field]) => !field.optional).map(([name]) => name);
const message = { type: "object", required: messageRequired, properties: messageProperties, additionalProperties: false };
const envelope = (data: ApiSchema) => ({ mediaType: "application/json", schema: { type: "object", required: ["code", "data"], additionalProperties: false,
  properties: { code: { const: 0 }, data } } });
const error = { mediaType: "application/json", schema: { type: "object", required: ["code", "errorCode"], additionalProperties: false,
  properties: { code: { const: -1 }, errorCode: text, message: text } } };

export function qqReadOperationContract(kind: QqReadTarget["kind"]): ApiOperationContract {
  const pathTemplate = kind === "history" ? "/api/agent/qq/history" : `/api/agent/qq/messages/:messageId${kind === "attachment" ? "/attachments/:attachmentIndex" : ""}`;
  const pathProperties = kind === "history" ? {} : { messageId: { type: "string", pattern: QQ_MESSAGE_ID_PATTERN.source },
    ...(kind === "attachment" ? { attachmentIndex: { type: "string", pattern: QQ_ATTACHMENT_INDEX_PATTERN.source } } : {}) };
  return {
    operationId: `agent.qq.${kind}.read`, aliases: [`agent:GET:${pathTemplate}`], contractVersion: "1.0.0", method: "GET", pathTemplate,
    description: kind === "history" ? "Read one bounded QQ history page for the selected conversation." : kind === "message" ? "Read one exact selected-conversation message and controlled attachment links." : "Read finite attachment bytes for one selected-conversation message; not a live upstream stream.",
    exposure: "public", transport: "http",
    request: { path: { type: "object", properties: pathProperties, required: Object.keys(pathProperties), additionalProperties: false },
      query: kind === "history" ? QQ_HISTORY_QUERY_SCHEMA : QQ_MESSAGE_QUERY_SCHEMA,
      headers: { type: "object", properties: { "content-length": false, "transfer-encoding": false }, additionalProperties: true }, body: { kind: "none" } },
    responses: { "200": kind === "attachment" ? { mediaType: "application/octet-stream", binary: { minBytes: 1, maxBytes: QQ_MEDIA_MAX_BYTES },
      headers: { type: "object", required: ["content-length", "x-rabiroute-content-sha256", "x-content-type-options", "content-disposition"], additionalProperties: true, properties: {
        "content-length": { type: "string", pattern: "^[1-9][0-9]*$" }, "x-rabiroute-content-sha256": { type: "string", pattern: "^[a-f0-9]{64}$" },
        "x-content-type-options": { const: "nosniff" }, "content-disposition": { type: "string", minLength: 1 }
      } } } : envelope(kind === "history" ? {
        type: "object", required: ["routeId", "instanceId", "entries", "nextCursor", "cursorStalled", "completenessUnknown"], additionalProperties: false,
        properties: { routeId: text, instanceId: text, entries: { type: "array", maxItems: QQ_READ_LIMITS.historyMax, items: message },
          nextCursor: { anyOf: [{ type: "null" }, { type: "string", pattern: QQ_MESSAGE_ID_PATTERN.source }] }, cursorStalled: { type: "boolean" }, completenessUnknown: { const: true } }
      } : { ...message, required: ["routeId", "instanceId", ...messageRequired], properties: { routeId: text, instanceId: text, ...messageProperties } }),
      "400": error, "403": error, "404": error, "405": error, "409": error, "413": error, "422": error, "429": error, "503": error },
    effects: { mode: "read", description: "Reads only the selected Route/conversation/message and bounded provider media. Never sends messages, downloads arbitrary caller URLs, or changes the selected account." },
    recovery: { strategy: "repeatable-read", description: "Retain the selected Route, conversation and original message/cursor. Completeness is unknown; missing data does not authorize switching to another account or message." },
    validators: [{ id: "agent.qq.read.current-source", description: "The existing owner revalidates the admitted connection and exact enabled Route/instance across each upstream await. Local, Agent, Relay and Peer callers retain the same shared success path." },
      { id: "agent.qq.read.bounds", description: `History limit is normalized with Number(value), default ${QQ_READ_LIMITS.historyDefault}, range 1..${QQ_READ_LIMITS.historyMax}; concurrency is configured by RABIROUTE_QQ_READ_CONCURRENCY. Exact-message fallback reads ${QQ_READ_LIMITS.fallbackCount} anchored records. Attachment bytes are buffered by the existing provider up to ${QQ_MEDIA_MAX_BYTES} bytes, with selected-message membership and trusted file/URL checks; this contract does not imply upstream streaming.` }]
  };
}
