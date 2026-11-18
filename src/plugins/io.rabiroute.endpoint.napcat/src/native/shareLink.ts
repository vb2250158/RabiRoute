import { compileApiContract, type ApiOperationContract, type ApiOperationDefinition } from "@rabiroute/host-api/manager/apiOperationContract";
import { qqReadSettings } from "@rabiroute/host-api/shared/qqReadSettings";
import { readExactQqMessage } from "../manager/qqMessageRoutes.js";
import { selectNapcatApiInstance, verifyNapcatApiIdentity, callNapcatApi, NapcatApiError, napcatApiFailure, type NapcatApiTransportContext } from "../manager/napcatApiTransport.js";
/** A share link is the requested capability, not a login credential. It is returned only to the admitted caller. */
export function createNapcatShareLinkOperation(context: NapcatApiTransportContext): ApiOperationDefinition {
    const empty = { type: "object", additionalProperties: false };
    const contract: ApiOperationContract = {
        operationId: "agent.qq.onebot.get_share_link", aliases: ["agent.qq.onebot.get_share_link_async", "agent.qq.onebot.get_share_link_rate_limited"],
        contractVersion: "1.0.0", method: "POST", pathTemplate: "/api/agent/qq/onebot/get_share_link", exposure: "public", transport: "http",
        description: "Read the native share link for the flash fileset in an exact authorized source message. Anyone holding this link can access its shared resource; required URL parameters are retained. The link is returned to the current caller, not written into ordinary Rabi events or chat logs. This source-bound input shape differs from unrestricted native fileset_id input.",
        request: { path: empty, query: empty, headers: { type: "object" }, body: { kind: "json", maxBytes: qqReadSettings.jsonBytes, schema: {
                    type: "object", additionalProperties: false, required: ["routeId", "instanceId", "params"], properties: {
                        routeId: { type: "string", minLength: 1, maxLength: 256 }, instanceId: { type: "string", minLength: 1, maxLength: 256 },
                        params: { type: "object", additionalProperties: false, required: ["source"], properties: {
                                source: { type: "object", additionalProperties: false, required: ["kind", "targetId", "messageId"], properties: {
                                        kind: { enum: ["group", "private"] }, targetId: { type: "string", pattern: "^[1-9][0-9]{0,15}$" },
                                        messageId: { type: "string", pattern: "^-?[0-9]{1,20}$" }
                                    } }
                            } }
                    }
                } } },
        responses: { "200": { mediaType: "application/json", schema: { type: "object", additionalProperties: false,
                    required: ["code", "shareLink", "access", "nativeContractEquivalent"], properties: {
                        code: { const: 0 }, shareLink: { type: "string", format: "uri" }, access: { const: "link-holder" }, nativeContractEquivalent: { const: false }
                    } } }, default: { mediaType: "application/json", schema: { type: "object", required: ["code", "errorCode"], properties: {
                        code: { const: -1 }, errorCode: { type: "string" }
                    } } } },
        effects: { mode: "read", description: "The original native GetShareLinkReq reads the selected source fileset's sharing capability. No external message or caller URL request is sent." },
        recovery: { strategy: "original-source-read", description: "Re-read only the same original authorized source. Native response data is request-local and never copied into a second capability store." },
        validators: [{ id: "napcat.share.original-source", description: "Original source message, selected Route/instance, actual QQ before/after, native result0, and an http(s) URL without userinfo or control characters." }]
    };
    const validator = compileApiContract({ contract }).bodyValidator!;
    return { contract, async handler(input) {
            const controller = new AbortController();
            const abort = () => controller.abort(input.signal?.reason);
            const timer = setTimeout(() => controller.abort(), qqReadSettings.readTimeoutMs);
            input.signal?.addEventListener("abort", abort, { once: true });
            try {
                if (!validator(input.body))
                    throw new NapcatApiError(400, "QQ_SHARE_LINK_INPUT_INVALID");
                if (input.signal?.aborted)
                    abort();
                const body = input.body as {
                    routeId: string;
                    instanceId: string;
                    params: {
                        source: {
                            kind: "group" | "private";
                            targetId: string;
                            messageId: string;
                        };
                    };
                };
                const selection = selectNapcatApiInstance(context, input.request, body.routeId, body.instanceId, controller.signal);
                await verifyNapcatApiIdentity(context, selection, controller.signal);
                const source = body.params.source;
                const message = await readExactQqMessage({ endpoint: selection, kind: source.kind, target: source.targetId, messageId: source.messageId,
                    signal: controller.signal, current: selection.assertCurrent, transport: context.transport });
                const segments = Array.isArray(message.message) ? message.message : [];
                const candidates = segments.filter(value => value?.type === "flashtransfer");
                const fileset = candidates.length === 1 ? candidates[0]?.data?.fileSetId : undefined;
                if (typeof fileset !== "string" || !fileset || /[\x00-\x1f\x7f]/.test(fileset)) {
                    throw new NapcatApiError(422, "QQ_SHARE_LINK_SOURCE_UNAVAILABLE");
                }
                const native = await callNapcatApi(context, selection, "get_share_link", { fileset_id: fileset }, new Set(["get_share_link"]), controller.signal);
                const result = native as {
                    result?: unknown;
                    shareLink?: unknown;
                } | null;
                if (result?.result !== 0 || typeof result.shareLink !== "string" || /[\x00-\x1f\x7f]/.test(result.shareLink)) {
                    throw new NapcatApiError(503, "QQ_SHARE_LINK_RESPONSE_INVALID");
                }
                let url: URL;
                try {
                    url = new URL(result.shareLink);
                }
                catch {
                    throw new NapcatApiError(503, "QQ_SHARE_LINK_RESPONSE_INVALID");
                }
                if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
                    throw new NapcatApiError(503, "QQ_SHARE_LINK_RESPONSE_INVALID");
                }
                await verifyNapcatApiIdentity(context, selection, controller.signal);
                return { status: 200, headers: { "cache-control": "private, no-store" },
                    body: { code: 0, shareLink: url.href, access: "link-holder", nativeContractEquivalent: false } };
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
