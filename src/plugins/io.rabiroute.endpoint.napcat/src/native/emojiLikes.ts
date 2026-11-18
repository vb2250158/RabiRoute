import { compileApiContract, type ApiOperationContract, type ApiOperationDefinition } from "@rabiroute/host-api/manager/apiOperationContract";
import { qqReadSettings } from "@rabiroute/host-api/shared/qqReadSettings";
import { getTimeoutMs } from "@rabiroute/host-api/shared/timeoutSettings";
import { readExactQqMessage } from "../manager/qqMessageRoutes.js";
import { callNapcatApi, NapcatApiError, napcatApiFailure, selectNapcatApiInstance, verifyNapcatApiIdentity, type NapcatApiTransportContext } from "../manager/napcatApiTransport.js";
const numericId = { type: "string", pattern: "^[1-9][0-9]{0,15}$" };
const sourceSchema = { type: "object", additionalProperties: false, required: ["kind", "targetId", "messageId"], properties: {
        kind: { enum: ["group", "private"] }, targetId: numericId, messageId: { type: "string", pattern: "^-?[0-9]{1,20}$" }
    } };
type Body = {
    routeId: string;
    instanceId: string;
    params: {
        source: {
            kind: "group" | "private";
            targetId: string;
            messageId: string;
        };
        emojiId: string;
        emojiType: string;
        count?: number;
        page?: number;
    };
    timeoutMs?: number;
};
/** Native cookies remain request-local; a bounded page traversal replaces public raw-cookie input and output. */
export function createNapcatEmojiLikesOperation(context: NapcatApiTransportContext): ApiOperationDefinition {
    const contract: ApiOperationContract = {
        operationId: "agent.qq.onebot.fetch_emoji_like", aliases: ["agent.qq.onebot.fetch_emoji_like_async", "agent.qq.onebot.fetch_emoji_like_rate_limited"],
        contractVersion: "1.0.0", method: "POST", pathTemplate: "/api/agent/qq/onebot/fetch_emoji_like", exposure: "public", transport: "http",
        description: "Source-bound emoji-like page view. Native cookies and avatar URLs are not returned. Requested pages are traversed from the first native page using request-local continuations, native termination and the configured timeout/response-byte budget. Page/count use JSON-safe integer representation; there is no extra business page quota. This is not an immutable snapshot or raw native cursor contract.",
        request: { path: { type: "object", additionalProperties: false }, query: { type: "object", additionalProperties: false }, headers: { type: "object" }, body: {
                kind: "json", maxBytes: qqReadSettings.jsonBytes, schema: { type: "object", additionalProperties: false, required: ["routeId", "instanceId", "params"], properties: {
                        routeId: { type: "string", minLength: 1, maxLength: 256 }, instanceId: { type: "string", minLength: 1, maxLength: 256 },
                        timeoutMs: { type: "integer", minimum: 1, maximum: 2147483647 },
                        params: { type: "object", additionalProperties: false, required: ["source", "emojiId", "emojiType"], properties: {
                                source: sourceSchema, emojiId: { type: "string", pattern: "^[0-9]{1,20}$" }, emojiType: { type: "string", pattern: "^[0-9]{1,20}$" },
                                count: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, page: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
                            } }
                    } }
            } },
        responses: { "200": { mediaType: "application/json", schema: { type: "object", additionalProperties: false,
                    required: ["code", "nativeContractEquivalent", "page", "nextPage", "continuationLimited", "entries"], properties: {
                        code: { const: 0 }, nativeContractEquivalent: { const: false }, page: { type: "integer", minimum: 0 },
                        nextPage: { type: ["integer", "null"] }, continuationLimited: { type: "boolean" },
                        entries: { type: "array", items: { type: "object", additionalProperties: false, required: ["tinyId", "nickname"], properties: {
                                    tinyId: { type: "string" }, nickname: { type: "string" }
                                } } }
                    } } }, default: { mediaType: "application/json", schema: { type: "object", required: ["code", "errorCode"], properties: {
                        code: { const: -1 }, errorCode: { type: "string" }
                    } } } },
        effects: { mode: "read", description: "Read likes only after proving the original selected account and exact message/conversation. Raw avatar capabilities and native continuation material remain private." },
        recovery: { strategy: "original-source-read", description: "A repeated page re-reads the same original message and bounded native pages. Live changes can affect page membership; no frozen-history guarantee is made." },
        validators: [{ id: "napcat.emoji.original-source", description: "Closed source selection, actual QQ/Route fences, native result0 and bounded request-local cursor traversal." }]
    };
    const validator = compileApiContract({ contract }).bodyValidator!;
    return { contract, async handler(input) {
            const controller = new AbortController();
            const abort = () => controller.abort(input.signal?.reason);
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                if (!validator(input.body)) {
                    throw new NapcatApiError(400, "QQ_EMOJI_LIKES_INPUT_INVALID");
                }
                const body = input.body as Body;
                input.signal?.addEventListener("abort", abort, { once: true });
                if (input.signal?.aborted) {
                    abort();
                }
                const timeoutMs = body.timeoutMs ?? getTimeoutMs("qq.emojiLikes", 60000);
                const deadline = performance.now() + timeoutMs;
                timer = setTimeout(() => controller.abort(), timeoutMs);
                const selection = selectNapcatApiInstance(context, input.request, body.routeId, body.instanceId, controller.signal);
                await verifyNapcatApiIdentity(context, selection, controller.signal);
                const source = body.params.source;
                await readExactQqMessage({ endpoint: selection, kind: source.kind, target: source.targetId, messageId: source.messageId,
                    current: selection.assertCurrent, signal: controller.signal, transport: context.transport });
                const page = body.params.page ?? 0;
                let cookie = "";
                for (let currentPage = 0; currentPage <= page; currentPage++) {
                    if (performance.now() >= deadline) {
                        throw new NapcatApiError(503, "QQ_EMOJI_LIKES_TIMEOUT");
                    }
                    const native = await callNapcatApi(context, selection, "fetch_emoji_like", {
                        message_id: source.messageId, emojiId: body.params.emojiId, emojiType: body.params.emojiType, count: body.params.count ?? 20, cookie
                    }, new Set(["fetch_emoji_like"]), controller.signal);
                    if (!native || typeof native !== "object") {
                        throw new NapcatApiError(503, "QQ_EMOJI_LIKES_RESPONSE_INVALID");
                    }
                    const result = native as Record<string, unknown>;
                    if (result.result !== 0 || !Array.isArray(result.emojiLikesList) || result.emojiLikesList.length > (body.params.count ?? 20)
                        || typeof result.isLastPage !== "boolean" || typeof result.cookie !== "string") {
                        throw new NapcatApiError(503, "QQ_EMOJI_LIKES_RESPONSE_INVALID");
                    }
                    const entries = result.emojiLikesList.map(value => {
                        if (!value || typeof value !== "object" || typeof value.tinyId !== "string" || typeof value.nickName !== "string") {
                            throw new NapcatApiError(503, "QQ_EMOJI_LIKES_RESPONSE_INVALID");
                        }
                        return { tinyId: value.tinyId, nickname: value.nickName };
                    });
                    if (currentPage === page || result.isLastPage) {
                        await verifyNapcatApiIdentity(context, selection, controller.signal);
                        const exhaustedBeforeRequestedPage = currentPage < page;
                        return { status: 200, body: { code: 0, nativeContractEquivalent: false, page,
                                nextPage: !result.isLastPage && page < Number.MAX_SAFE_INTEGER ? page + 1 : null,
                                continuationLimited: !result.isLastPage && page === Number.MAX_SAFE_INTEGER,
                                entries: exhaustedBeforeRequestedPage ? [] : entries } };
                    }
                    if (!result.cookie || result.cookie === cookie) {
                        throw new NapcatApiError(503, "QQ_EMOJI_LIKES_CONTINUATION_INVALID");
                    }
                    cookie = result.cookie;
                }
                throw new NapcatApiError(503, "QQ_EMOJI_LIKES_RESPONSE_INVALID");
            }
            catch (error) {
                return napcatApiFailure(error);
            }
            finally {
                clearTimeout(timer);
                input.signal?.removeEventListener("abort", abort);
            }
        } };
}
