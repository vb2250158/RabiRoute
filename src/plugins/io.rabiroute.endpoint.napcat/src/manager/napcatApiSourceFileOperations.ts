import { compileApiContract, validateApiOperationResult, type ApiOperationDefinition, type ApiOperationResult } from "@rabiroute/host-api/manager/apiOperationContract";
import { qqReadSettings } from "@rabiroute/host-api/shared/qqReadSettings";
import { napcatApiFailure, type NapcatApiTransportContext } from "./napcatApiTransport.js";
import { QqReadError, QQ_MEDIA_MAX_BYTES } from "./qqMessageMedia.js";
import { readSourceFile, privateFileBodySchema, groupFileBodySchema, type SourceFileInput } from "./napcatApiSourceFiles.js";
import { createSourceFileHashOperation } from "./napcatApiSourceFileHash.js";

const empty = { type: "object", additionalProperties: false };
const errorSchema = { type: "object", additionalProperties: false, required: ["code", "errorCode"], properties: { code: { const: -1 }, errorCode: { type: "string" } } };

/** Two fixed byte-view replacements plus the explicit Rabi-only streaming hash operation. */
export function createSourceFileOperations(context: NapcatApiTransportContext): readonly ApiOperationDefinition[] {
  const files = (["private", "group"] as const).map<ApiOperationDefinition>(kind => {
    const action = `get_${kind}_file_url`;
    const contract = {
      operationId: `agent.qq.onebot.${action}`, aliases: [`agent.qq.onebot.${action}_async`, `agent.qq.onebot.${action}_rate_limited`],
      contractVersion: "1.0.0", method: "POST" as const, pathTemplate: `/api/agent/qq/onebot/${action}`, exposure: "public" as const, transport: "http" as const,
      description: "Source-bound binary file view. nativeContractEquivalent=false. Exact messages use converter-cached UUIDs; group metadata accepts the native expiring 32hex cache reference with a generic filename. Alias names share this byte view.",
      request: { path: empty, query: empty, headers: { type: "object" }, body: { kind: "json" as const, maxBytes: qqReadSettings.jsonBytes,
        schema: kind === "private" ? privateFileBodySchema : groupFileBodySchema }, deadlineMs: qqReadSettings.readTimeoutMs },
      responses: {
        "200": { mediaType: "application/octet-stream", binary: { minBytes: 0, maxBytes: QQ_MEDIA_MAX_BYTES }, headers: {
          type: "object", additionalProperties: true,
          required: ["content-length", "content-disposition", "x-rabiroute-content-sha256", "x-content-type-options", "x-rabiroute-native-contract-equivalent"],
          properties: { "content-length": { type: "string", pattern: "^(0|[1-9][0-9]*)$" }, "content-disposition": { type: "string", minLength: 1 },
            "x-rabiroute-content-sha256": { type: "string", pattern: "^[a-f0-9]{64}$" }, "x-content-type-options": { const: "nosniff" },
            "x-rabiroute-native-contract-equivalent": { const: "false" } }
        } },
        default: { mediaType: "application/json", schema: errorSchema }
      },
      effects: { mode: "read" as const, description: "Fixed native group/private URL actions resolve authorized resources. The original media owner reads finite bytes. Native URLs remain request-local; native filesystem paths are never opened." },
      recovery: { strategy: "repeatable-original-source", description: "Retain exact Route/instance/message selection or original native group cache ID. Cache references expire or disappear on restart. Cache miss never triggers re-listing, filename guesses, ID conversion or replay." },
      validators: [
        { id: "napcat.resource.original-source", description: "Original source and actual configured QQ identity are rechecked across the operation. Existing group-file policy applies only to its original scope." },
        { id: "napcat.resource.final-account", description: "After complete bytes, get_login_info must still match the selected account. The native client offers no atomic cross-client account snapshot." },
        { id: "napcat.resource.url-only", description: "New public entries never open native host paths. Local-file-only results require a supported native URL or a future real same-host owner capability." }
      ]
    };
    const compiled = compileApiContract({ contract });
    return { contract, discovery: { title: `Read source-bound ${kind} file bytes`, summary: contract.description,
      keywords: ["NapCat", "QQ", "file", "binary", "source"], category: { id: "qq-onebot", title: "QQ / NapCat" },
      relatedOperations: ["agent.qq.message.read", "agent.qq.attachment.read", ...(kind === "group" ? ["agent.qq.group-files.read"] : [])] },
    handler: async input => {
      if (!compiled.bodyValidator?.(input.body)) return { status: 400, body: { code: -1, errorCode: "QQ_RESOURCE_INPUT_INVALID" } };
      const controller = new AbortController();
      const abort = () => controller.abort(input.signal?.reason);
      if (input.signal?.aborted) abort();
      input.signal?.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => controller.abort(), qqReadSettings.readTimeoutMs);
      try {
        const value = await readSourceFile(context, input.request, input.body as SourceFileInput, controller.signal);
        const wellFormedName = Buffer.from(value.name, "utf8").toString("utf8");
        const encodedName = encodeURIComponent(wellFormedName).replace(/['()*]/g, character =>
          `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
        const result: ApiOperationResult = { status: 200, body: value.bytes, headers: { "cache-control": "private, no-store",
          "content-type": "application/octet-stream", "content-length": String(value.bytes.length),
          "content-disposition": `attachment; filename*=UTF-8''${encodedName}`, "x-rabiroute-content-sha256": value.sha256,
          "x-content-type-options": "nosniff", "x-rabiroute-native-contract-equivalent": "false" } };
        validateApiOperationResult(compiled, result);
        return result;
      } catch (error) {
        // Preserve the original media owner's safe error projection.
        return error instanceof QqReadError ? { status: error.status, body: { code: -1, errorCode: error.code } } : napcatApiFailure(error);
      } finally { clearTimeout(timeout); input.signal?.removeEventListener("abort", abort); }
    } };
  });
  return [...files, createSourceFileHashOperation(context)];
}
