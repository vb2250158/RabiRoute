import { compileApiContract, validateApiOperationResult, type ApiOperationDefinition } from "@rabiroute/host-api/manager/apiOperationContract";
import { qqReadSettings } from "@rabiroute/host-api/shared/qqReadSettings";
import { napcatApiFailure, type NapcatApiTransportContext } from "./napcatApiTransport.js";
import { QqReadError } from "./qqMessageMedia.js";
import { privateFileBodySchema, groupFileBodySchema, verifySourceFileSha256, type SourceFileHashInput } from "./napcatApiSourceFiles.js";

const empty = { type: "object", additionalProperties: false };
const finiteSize = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const sha256 = { type: "string", pattern: "^[a-fA-F0-9]{64}$" };
const sources = [privateFileBodySchema, ...groupFileBodySchema.oneOf];
const bodySchema = { oneOf: sources.map(source => ({ ...source, required: [...source.required, "expectedSize", "expectedSha256"],
  properties: { ...source.properties, expectedSize: finiteSize, expectedSha256: sha256,
    timeoutMs: { type: "integer", minimum: 1, maximum: 2_147_483_647,
      description: "Explicit finite owner budget in milliseconds. Omit to use the current qq.media timeout setting. Caller cancellation remains active." } } })) };

/** Explicit read verification, independent of delivery or receipt settlement. */
export function createSourceFileHashOperation(context: NapcatApiTransportContext): ApiOperationDefinition {
  const contract = {
    operationId: "agent.qq.file.verify-sha256", contractVersion: "1.0.0", method: "POST" as const,
    pathTemplate: "/api/agent/qq/files/sha256", exposure: "public" as const, transport: "http" as const,
    description: "Read the complete original source through a bounded incremental SHA256 stream. Returns a digest and comparison, without materializing binary, saving a file or changing a delivery receipt.",
    request: { path: empty, query: empty, headers: { type: "object" }, body: { kind: "json" as const,
      maxBytes: qqReadSettings.jsonBytes, schema: bodySchema } },
    responses: {
      "200": { mediaType: "application/json", schema: { type: "object", additionalProperties: false,
        required: ["actualSize", "sha256", "expectedSize", "sizeMatches", "sha256Matches", "source", "nativeContractEquivalent", "receiptUpdated"],
        properties: { actualSize: finiteSize, sha256, expectedSize: finiteSize, sizeMatches: { const: true }, sha256Matches: { type: "boolean" },
          source: { oneOf: sources }, nativeContractEquivalent: { const: false }, receiptUpdated: { const: false } } } },
      default: { mediaType: "application/json", schema: { type: "object", additionalProperties: false, required: ["code", "errorCode"],
        properties: { code: { const: -1 }, errorCode: { type: "string" } } } }
    },
    effects: { mode: "read" as const, description: "Fixed native source URL resolution plus finite HTTP stream read. Expected size is the explicit per-call byte ceiling. Existing binary materialization quota is unchanged." },
    recovery: { strategy: "explicit-original-source-read", description: "A failed or cancelled read has no completed digest. Do not replay sends, repair old receipts, guess expired cache IDs or automatically restart a verification." },
    validators: [
      { id: "napcat.hash.bound", description: "Exact expectedSize and expectedSha256 are required. EOF must match size before a complete digest is returned." },
      { id: "napcat.hash.identity", description: "Configured account and original selection are checked before source resolution and after EOF. There is no native cross-client atomic account snapshot." },
      { id: "napcat.hash.deadline", description: "The owner enforces explicit finite timeoutMs, or the normal qq.media default, plus caller cancellation. A short static API deadline does not override a larger explicit file budget. No global settings are changed." }
    ]
  };
  const compiled = compileApiContract({ contract });
  return { contract, discovery: { title: "Verify the complete QQ file SHA256", summary: contract.description,
    category: { id: "qq-onebot", title: "QQ / NapCat" }, keywords: ["file", "SHA256", "stream", "verify"],
    relatedOperations: ["agent.qq.onebot.get_group_file_url", "agent.qq.onebot.get_private_file_url", "agent.qq.message.read"] },
  handler: async input => {
    if (!compiled.bodyValidator?.(input.body)) return { status: 400, body: { code: -1, errorCode: "QQ_FILE_HASH_INPUT_INVALID" } };
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort(input.signal?.reason);
    if (input.signal?.aborted) abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    const timeoutMs = (input.body as { timeoutMs?: number }).timeoutMs ?? qqReadSettings.mediaTimeoutMs;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const body = await verifySourceFileSha256(context, input.request, input.body as SourceFileHashInput, controller.signal);
      const result = { status: 200, body, headers: { "cache-control": "private, no-store" } };
      validateApiOperationResult(compiled, result);
      return result;
    } catch (error) {
      if (timedOut) return { status: 503, body: { code: -1, errorCode: "QQ_READ_TIMEOUT" } };
      if (input.signal?.aborted) return { status: 503, body: { code: -1, errorCode: "QQ_READ_CANCELLED" } };
      return error instanceof QqReadError ? { status: error.status, body: { code: -1, errorCode: error.code } } : napcatApiFailure(error);
    } finally { clearTimeout(timer); input.signal?.removeEventListener("abort", abort); }
  } };
}
