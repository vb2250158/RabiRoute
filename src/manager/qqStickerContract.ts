import { constants as bufferConstants } from "node:buffer";
import { QQ_STICKER_ID, QQ_STICKER_LIMITS } from "../napcatStickers.js";
import { freezeApiData, type ApiOperationContract } from "./apiOperationContract.js";


export const QQ_STICKER_QUERY_SCHEMA = freezeApiData({ type: "object", required: ["routeId"], additionalProperties: false,
  properties: { routeId: { type: "string", minLength: 1, maxLength: QQ_STICKER_LIMITS.routeIdChars },
    instanceId: { type: "string", minLength: 1, maxLength: QQ_STICKER_LIMITS.instanceIdChars },
    count: { type: "string", minLength: 1, description: `Number(value) normalization, integer from 1 through RABIROUTE_QQ_STICKER_COUNT; defaults to the maximum. Preview lookup always uses the maximum.` } } });
const text = { type: "string" } as const;
const item = { type: "object", required: ["id", "name", "description", "previewUrl"], additionalProperties: false,
  properties: { id: { type: "string", pattern: QQ_STICKER_ID.source }, name: text, description: text, previewUrl: text } };
const error = { mediaType: "application/json", schema: { type: "object", required: ["code", "errorCode"], additionalProperties: false,
  properties: { code: { const: -1 }, errorCode: text, message: text } } };
export function qqStickerOperationContract(preview: boolean): ApiOperationContract {
  const pathTemplate = `/api/agent/qq/stickers${preview ? "/:stickerId/preview" : ""}`;
  const image = (mediaType: string) => ({ mediaType, binary: { minBytes: 1, maxBytes: bufferConstants.MAX_LENGTH },
    headers: { type: "object", required: ["content-length", "x-content-type-options"], additionalProperties: true,
      properties: { "content-length": { type: "string", pattern: "^[1-9][0-9]*$" }, "x-content-type-options": { const: "nosniff" }, "content-type": { type: "string", pattern: "^image/[^*]+$" } } } });
  return { operationId: preview ? "agent.qq.sticker.preview" : "agent.qq.stickers.read", aliases: [`agent:GET:${pathTemplate}`],
    contractVersion: "1.0.0", method: "GET", pathTemplate, exposure: "public", transport: "http",
    description: preview ? "Read one finite image from the selected account's current favorite stickers." : "Read the selected QQ account's favorite sticker metadata and controlled preview links.",
    request: { path: { type: "object", required: preview ? ["stickerId"] : [], additionalProperties: false,
      properties: preview ? { stickerId: { type: "string", pattern: QQ_STICKER_ID.source } } : {} }, query: QQ_STICKER_QUERY_SCHEMA,
      headers: { type: "object", properties: { "content-length": false, "transfer-encoding": false }, additionalProperties: true }, body: { kind: "none" } },
    responses: { "200": preview ? image("*/*")
      : { mediaType: "application/json", schema: { type: "object", required: ["code", "data"], additionalProperties: false,
        properties: { code: { const: 0 }, data: { type: "object", required: ["routeId", "instanceId", "items", "completenessUnknown", "potentiallyTruncated"], additionalProperties: false,
          properties: { routeId: text, instanceId: text, items: { type: "array", items: item },
            completenessUnknown: { const: true }, potentiallyTruncated: { type: "boolean" } } } } } },
      "400": error, "403": error, "404": error, "405": error, "409": error, "503": error },
    effects: { mode: "read", description: "Reads a single selected enabled QQ account. Native media URLs and account credentials remain inside the provider owner." },
    recovery: { strategy: "repeatable-read", description: "Refresh the same account's list before selecting a preview; a missing item does not authorize a different account." },
    validators: [{ id: "agent.qq.stickers.current-source", description: "The existing owner revalidates connection, enabled Route and exact account endpoint after upstream work, before exposing results." },
      { id: "agent.qq.stickers.bounds", description: `Count uses Number(value), integer from 1 through RABIROUTE_QQ_STICKER_COUNT, configurable by RABIROUTE_QQ_STICKER_COUNT. Returned NapCat resources need no host grant. Preview quota is configured by RABIROUTE_QQ_STICKER_PREVIEW_MAX_BYTES (0 means runtime capacity only); runtime buffer capacity ${bufferConstants.MAX_LENGTH} bytes. Deadline is configured by RABIROUTE_QQ_STICKER_PREVIEW_TIMEOUT_MS. No live upstream streaming.` }] };
}
