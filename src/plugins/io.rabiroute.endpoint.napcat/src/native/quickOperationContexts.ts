import { createHash } from "node:crypto";
import { NapcatApiError } from "../manager/napcatApiTransport.js";
export type QuickOperationSourceIdentity = Readonly<{
    routeId: string;
    instanceId: string;
    botUserId: string;
    httpUrl: string;
    accessToken: string;
}>;
export type QuickOperationPrivateObjects = Readonly<{
    putProtected(owner: string, plaintext: Buffer, authorize: () => void, signal?: AbortSignal): Promise<{
        id: string;
    }>;
    readProtected(owner: string, id: string, authorize: () => void, signal?: AbortSignal): Promise<Buffer>;
}>;
export type QuickRequestContext = Readonly<{
    post_type: "request";
    request_type: "friend" | "group";
    self_id: string;
    user_id: string;
    group_id?: string;
    sub_type?: "add" | "invite";
    flag: string;
}>;
const numericId = /^[1-9]\d{0,15}$/;
const referenceId = /^[a-f0-9]{64}$/;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** The secret affects the binding fingerprint; it is never copied to a log or public result. */
function identity(source: QuickOperationSourceIdentity): string {
    if (!source.routeId || !source.instanceId || !numericId.test(source.botUserId)) {
        throw new NapcatApiError(409, "QQ_QUICK_SOURCE_INVALID");
    }
    let url: URL;
    try {
        url = new URL(source.httpUrl);
    }
    catch {
        throw new NapcatApiError(409, "QQ_QUICK_SOURCE_INVALID");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
        throw new NapcatApiError(409, "QQ_QUICK_SOURCE_INVALID");
    }
    return digest([source.routeId, source.instanceId, source.botUserId, url.href, source.accessToken]);
}
function parseRequest(value: unknown, botUserId: string): QuickRequestContext | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return;
    const event = value as Record<string, unknown>;
    if (event.post_type !== "request" || !["friend", "group"].includes(String(event.request_type))
        || String(event.self_id) !== botUserId || !numericId.test(String(event.user_id))
        || typeof event.flag !== "string" || !event.flag || event.flag.length > 4096 || /[\x00-\x1f\x7f]/.test(event.flag))
        return;
    if (event.request_type === "group" && (!numericId.test(String(event.group_id)) || !["add", "invite"].includes(String(event.sub_type))))
        return;
    return {
        post_type: "request", request_type: event.request_type as "friend" | "group",
        self_id: botUserId, user_id: String(event.user_id), flag: event.flag,
        ...(event.request_type === "group" ? { group_id: String(event.group_id), sub_type: event.sub_type as "add" | "invite" } : {})
    };
}
/** Called only by the admitted original WS frame. Ordinary messages never incur an encryption operation. */
export async function captureNapcatQuickRequestContext(objects: QuickOperationPrivateObjects, source: QuickOperationSourceIdentity, event: unknown, authorize: () => void, signal: AbortSignal): Promise<string | undefined> {
    signal.throwIfAborted();
    authorize();
    const request = parseRequest(event, source.botUserId);
    if (!request)
        return;
    const sourceIdentity = identity(source), owner = `napcat.quick-request.${sourceIdentity}`;
    const saved = await objects.putProtected(owner, Buffer.from(JSON.stringify({
        kind: "napcat-quick-request/v1", sourceIdentity, request
    })), () => {
        signal.throwIfAborted();
        authorize();
    }, signal);
    signal.throwIfAborted();
    authorize();
    if (!referenceId.test(saved.id))
        throw new NapcatApiError(503, "QQ_QUICK_CONTEXT_INVALID");
    return saved.id;
}
/** Only authenticated issuer envelopes from this original Route/instance/QQ/HTTP+auth source are accepted. */
export async function readNapcatQuickRequestContext(objects: QuickOperationPrivateObjects, source: QuickOperationSourceIdentity, eventRef: string, authorize: () => void, signal: AbortSignal): Promise<QuickRequestContext> {
    signal.throwIfAborted();
    authorize();
    if (!referenceId.test(eventRef))
        throw new NapcatApiError(400, "QQ_QUICK_EVENT_REF_INVALID");
    const sourceIdentity = identity(source);
    let value: {
        kind?: unknown;
        sourceIdentity?: unknown;
        request?: unknown;
    };
    try {
        value = JSON.parse(Buffer.from(await objects.readProtected(`napcat.quick-request.${sourceIdentity}`, eventRef, authorize, signal)).toString("utf8"));
    }
    catch {
        signal.throwIfAborted();
        authorize();
        throw new NapcatApiError(404, "QQ_QUICK_EVENT_REF_NOT_FOUND");
    }
    const request = parseRequest(value.request, source.botUserId);
    if (value.kind !== "napcat-quick-request/v1" || value.sourceIdentity !== sourceIdentity || !request) {
        throw new NapcatApiError(409, "QQ_QUICK_CONTEXT_INVALID");
    }
    signal.throwIfAborted();
    authorize();
    return request;
}
