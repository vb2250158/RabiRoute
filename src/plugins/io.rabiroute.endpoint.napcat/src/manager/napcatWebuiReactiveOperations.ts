import { randomUUID } from "node:crypto";
import type { ApiOperationDefinition } from "@rabiroute/host-api/manager/apiOperationContract";
import { compileApiContract } from "@rabiroute/host-api/manager/apiOperationContract";
import { executeDurableDelivery, readDurableDeliveryReceipt } from "@rabiroute/host-api/manager/durableDeliveryIdempotency";
import { qqReadSettings } from "@rabiroute/host-api/shared/qqReadSettings";
import { contractFor, ManagementError, callNapcatWebuiManagement as call, checkNapcatWebuiManagementAccount as account, napcatWebuiDigest as digest, selectNapcatWebuiManagementInstance, type NapcatWebuiManagementContext, type NapcatWebuiManagementSelection, type NapcatWebuiManagementSession } from "./napcatWebuiManagementOperations.js";
import { napcatApiFailure } from "./napcatApiTransport.js";
import { putNapcatWebuiObject, napcatWebuiObjectReferenceSchema, type WebuiObjectReference } from "./napcatWebuiResources.js";
type Row = Record<string, unknown>;
type Lease = {
    id: string;
    pluginId: string;
    binding: NapcatWebuiManagementSelection;
    session: NapcatWebuiManagementSession;
    controller: AbortController;
    nativeId?: string;
    events: Array<{
        type: string;
        bytes: number;
        artifact?: WebuiObjectReference;
    }>;
    error?: string;
    timer?: NodeJS.Timeout;
    ready: Promise<void>;
    pump?: Promise<void>;
};
const text = {
    type: "string", minLength: 1, maxLength: 256
} as const;
const json = { type: "object", maxProperties: 256 } as const;
const closed = (properties: Row, required: string[]) => ({
    type: "object", additionalProperties: false, properties, required
});
/** Native reactive config controller leases are activation-owned and never accept native session IDs from callers. */
export function createNapcatWebuiReactiveOwner(context: NapcatWebuiManagementContext): {
    operations: readonly ApiOperationDefinition[];
    dispose(): Promise<void>;
} {
    const leases = new Map<string, Lease>();
    const controllers = new Set<AbortController>();
    const tasks = new Set<Promise<unknown>>();
    let disposed = false;
    const assertOwner = () => {
        if (disposed)
            throw new ManagementError("REACTIVE_OWNER_RETIRED", 409);
    };
    const track = <T>(task: Promise<T>): Promise<T> => {
        tasks.add(task);
        void task.then(() => tasks.delete(task), () => tasks.delete(task));
        return task;
    };
    const abortLease = (lease: Lease) => {
        leases.delete(lease.id);
        clearTimeout(lease.timer);
        lease.controller.abort();
    };
    const close = async (lease: Lease) => {
        abortLease(lease);
        await lease.pump;
    };
    function open(binding: NapcatWebuiManagementSelection, session: NapcatWebuiManagementSession, pluginId: string, initial: Row, openingSignal: AbortSignal): Promise<Lease> {
        assertOwner();
        const controller = new AbortController();
        controllers.add(controller);
        const abortOpening = () => controller.abort(openingSignal.reason);
        openingSignal.addEventListener("abort", abortOpening, { once: true });
        if (openingSignal.aborted)
            abortOpening();
        const lease: Lease = {
            id: randomUUID(), pluginId, binding, session, controller, events: [], ready: Promise.resolve()
        };
        const opening = (async () => {
            let readyResolved = false;
            let resolveReady!: () => void;
            let rejectReady!: (error: Error) => void;
            try {
                // A retained controller belongs to its native lease, not the completed opening HTTP request.
                session = await context.openManagementSession(binding, controller.signal);
                lease.session = session;
                await account(session, binding, controller.signal);
                const response = await session.requestManagement("GET", "/api/Plugin/Config/SSE", { id: pluginId, config: JSON.stringify(initial) }, controller.signal);
                if (disposed || controller.signal.aborted) {
                    await response.body?.cancel();
                    throw new ManagementError("REACTIVE_OWNER_RETIRED", 409);
                }
                if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
                    await response.body?.cancel();
                    throw new ManagementError("REACTIVE_STREAM_UNAVAILABLE");
                }
                leases.set(lease.id, lease);
                lease.ready = new Promise((resolve, reject) => {
                    resolveReady = () => {
                        readyResolved = true;
                        resolve();
                    };
                    rejectReady = reject;
                });
                lease.timer = setTimeout(() => {
                    rejectReady(new ManagementError("REACTIVE_LEASE_EXPIRED", 409));
                    abortLease(lease);
                }, qqReadSettings.readTimeoutMs);
                lease.timer.unref();
                const reader = response.body.getReader();
                let cancellation: Promise<void> | undefined;
                const cancelReader = () => cancellation ??= reader.cancel().catch(() => undefined);
                const cancelOnAbort = () => {
                    void cancelReader();
                };
                controller.signal.addEventListener("abort", cancelOnAbort, { once: true });
                lease.pump = track((async () => {
                    let pending = "";
                    let bytes = 0;
                    const decoder = new TextDecoder();
                    try {
                        while (!controller.signal.aborted) {
                            const next = await reader.read();
                            if (next.done)
                                break;
                            bytes += next.value.length;
                            if (bytes > qqReadSettings.jsonBytes)
                                throw new ManagementError("REACTIVE_STREAM_BUDGET");
                            pending += decoder.decode(next.value, { stream: true });
                            for (;;) {
                                const match = /\r?\n\r?\n/.exec(pending);
                                if (!match)
                                    break;
                                const block = pending.slice(0, match.index);
                                pending = pending.slice(match.index + match[0].length);
                                const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
                                if (!data)
                                    continue;
                                const event = JSON.parse(data) as Row;
                                if (!event || typeof event !== "object")
                                    throw new ManagementError("REACTIVE_STREAM_INVALID");
                                const type = block.split(/\r?\n/).find(line => line.startsWith("event:"))?.slice(6).trim() ?? "message";
                                if (type === "connected") {
                                    if (typeof event.sessionId !== "string" || !event.sessionId)
                                        throw new ManagementError("REACTIVE_SESSION_INVALID");
                                    lease.nativeId = event.sessionId;
                                    resolveReady();
                                }
                                if (lease.events.length >= 256)
                                    throw new ManagementError("REACTIVE_EVENT_BUDGET");
                                const artifact = type === "schema" ? await putNapcatWebuiObject(context, binding, "public-artifact", Buffer.from(data), "application/json", "plugin-config-event.json") : undefined;
                                lease.events.push({
                                    type, bytes: Buffer.byteLength(data), ...(artifact ? { artifact } : {})
                                });
                            }
                        }
                        if (!controller.signal.aborted)
                            throw new ManagementError("REACTIVE_STREAM_CLOSED");
                    }
                    catch {
                        lease.error = "NATIVE_REACTIVE_STREAM_CLOSED";
                        if (!readyResolved)
                            rejectReady(new ManagementError("REACTIVE_STREAM_CLOSED"));
                        abortLease(lease);
                    }
                    finally {
                        controller.signal.removeEventListener("abort", cancelOnAbort);
                        await cancelReader();
                        reader.releaseLock();
                        controllers.delete(controller);
                        leases.delete(lease.id);
                    }
                })());
                await lease.ready;
                openingSignal.removeEventListener("abort", abortOpening);
                assertOwner();
                return lease;
            }
            catch (error) {
                openingSignal.removeEventListener("abort", abortOpening);
                controller.abort();
                if (!readyResolved)
                    rejectReady?.(new ManagementError("REACTIVE_STREAM_CLOSED"));
                if (lease.pump)
                    await lease.pump;
                controllers.delete(controller);
                leases.delete(lease.id);
                throw error;
            }
        })();
        return track(opening);
    }
    const specs = [
        {
            id: "plugin.config.events.open", nativePath: "/api/Plugin/Config/SSE", params: closed({ id: { ...text, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }, initialConfig: json }, ["id", "initialConfig"]), mutation: true
        },
        {
            id: "plugin.config.events.read", nativePath: "/api/Plugin/Config/SSE", params: closed({ leaseId: text }, ["leaseId"]), mutation: false
        },
        {
            id: "plugin.config.events.close", nativePath: "/api/Plugin/Config/SSE", params: closed({ leaseId: text }, ["leaseId"]), mutation: true
        },
        {
            id: "plugin.config.change", nativePath: "/api/Plugin/Config/Change", params: closed({
                leaseId: text, key: text, value: {}, currentConfig: json
            }, [
                "leaseId", "key", "value", "currentConfig"
            ]), mutation: true
        }
    ];
    const operations: ApiOperationDefinition[] = specs.map(spec => {
        const contract = contractFor({
            id: spec.id, method: "POST", nativePath: spec.nativePath, params: spec.params, response: closed({
                leaseId: text, active: { type: "boolean" }, accepted: { type: "boolean" }, events: { type: "array", items: closed({
                        type: text, bytes: { type: "integer" }, artifact: napcatWebuiObjectReferenceSchema
                    }, ["type", "bytes"]) }
            }, ["leaseId", "active"]), binding: "management-bootstrap", effects: spec.mutation ? "configuration-mutation" : "none", description: "Original native plugin config controller. Only opaque activation-owned lease IDs and event metadata are public; native session IDs and provider errors are never returned; full config/schema is retained only in caller-owned protected artifacts. Lease expiry/retirement closes the original SSE and invokes native cleanup.", sourceLines: spec.id === "plugin.config.change" ? { route: 96193, handlers: [95622] } : { route: 96192, handlers: [95526] }
        }), compiled = compileApiContract({ contract });
        return {
            contract, discovery: { title: `NapCat ${spec.id}`, category: { id: "qq-webui", title: "QQ / NapCat management" } }, handler: async (input) => {
                try {
                    assertOwner();
                    if (input.url.pathname !== contract.pathTemplate || input.url.search || Object.keys(input.query ?? {}).length || Object.keys(input.path ?? {}).length || !compiled.bodyValidator?.(input.body))
                        throw new ManagementError("PARAMETERS_INVALID", 400);
                    if (spec.mutation && context.readOnly())
                        throw new ManagementError("READ_ONLY", 403);
                    const body = input.body as {
                        routeId: string;
                        instanceId: string;
                        params: Row;
                        deliveryId?: string;
                    };
                    const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(qqReadSettings.readTimeoutMs)]) : AbortSignal.timeout(qqReadSettings.readTimeoutMs);
                    const binding = selectNapcatWebuiManagementInstance(context, input.request, body.routeId, body.instanceId, signal), session = await context.openManagementSession(binding, signal);
                    await account(session, binding, signal);
                    const find = () => {
                        const lease = leases.get(String(body.params.leaseId));
                        if (!lease || lease.binding.routeId !== binding.routeId || lease.binding.instanceId !== binding.instanceId || lease.binding.expectedUserId !== binding.expectedUserId)
                            throw new ManagementError("REACTIVE_LEASE_NOT_FOUND", 404);
                        lease.binding.assertCurrent();
                        lease.session.assertCurrent();
                        return lease;
                    };
                    const prior = body.deliveryId ? readDurableDeliveryReceipt(context.rootDir, "napcat-webui-management-v1", body.deliveryId) : undefined;
                    const original = prior?.audit as Row | undefined;
                    const existingOriginal = original?.operation === spec.id && original.routeId === binding.routeId && original.instanceId === binding.instanceId && original.expectedUserId === binding.expectedUserId;
                    if (!spec.id.endsWith(".open") && !existingOriginal)
                        find();
                    const execute = async () => {
                        if (spec.id.endsWith(".open")) {
                            const leaseBinding = selectNapcatWebuiManagementInstance(context, input.request, body.routeId, body.instanceId);
                            const lease = await open(leaseBinding, session, String(body.params.id), body.params.initialConfig as Row, signal);
                            return {
                                leaseId: lease.id, active: true, events: lease.events.slice()
                            };
                        }
                        const lease = find();
                        if (spec.id.endsWith(".close")) {
                            await close(lease);
                            return { leaseId: lease.id, active: false };
                        }
                        if (spec.id.endsWith(".read"))
                            return {
                                leaseId: lease.id, active: !lease.controller.signal.aborted, events: lease.events.slice()
                            };
                        await account(lease.session, lease.binding, signal);
                        await call(lease.session, lease.binding, "POST", "/api/Plugin/Config/Change", {
                            id: lease.pluginId, sessionId: lease.nativeId, key: body.params.key, value: body.params.value, currentConfig: body.params.currentConfig
                        }, signal);
                        await account(lease.session, lease.binding, signal);
                        return {
                            leaseId: lease.id, active: true, accepted: true
                        };
                    };
                    if (!spec.mutation)
                        return {
                            status: 200, headers: { "cache-control": "private, no-store" }, body: { code: 0, data: await execute() }
                        };
                    const outcome = await session.runBindingOperation(() => executeDurableDelivery({
                        rootDir: context.rootDir, namespace: "napcat-webui-management-v1", deliveryId: body.deliveryId, payload: {
                            operation: spec.id, routeId: body.routeId, instanceId: body.instanceId, expectedUserId: binding.expectedUserId, paramsDigest: digest(body.params)
                        }, audit: {
                            operation: spec.id, routeId: body.routeId, instanceId: body.instanceId, expectedUserId: binding.expectedUserId
                        }, requestAuthority: binding.assertCurrent, deliver: execute
                    }));
                    if (outcome.state === "conflict")
                        throw new ManagementError("DELIVERY_CONFLICT", 409);
                    if (outcome.state === "completed") {
                        const result = outcome.result as {
                            leaseId: string;
                        };
                        return { status: 200, body: {
                                code: 0, data: { ...result, active: leases.has(result.leaseId) }, delivery: {
                                    deliveryId: outcome.deliveryId, state: outcome.state, duplicate: outcome.duplicate
                                }
                            } };
                    }
                    return { status: 202, body: { code: 0, delivery: {
                                deliveryId: outcome.deliveryId, state: outcome.state, retryable: false
                            } } };
                }
                catch (error) {
                    return napcatApiFailure(error);
                }
            }
        };
    });
    return { operations, dispose: async () => {
            disposed = true;
            for (const controller of controllers)
                controller.abort();
            for (const lease of leases.values())
                abortLease(lease);
            while (tasks.size)
                await Promise.allSettled([...tasks]);
        } };
}
