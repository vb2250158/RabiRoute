import type { ApiOperationDefinition } from "@rabiroute/host-api/manager/apiOperationContract";
import { compileApiContract } from "@rabiroute/host-api/manager/apiOperationContract";
import { executeDurableDelivery } from "@rabiroute/host-api/manager/durableDeliveryIdempotency";
import { qqReadSettings } from "@rabiroute/host-api/shared/qqReadSettings";
import { napcatApiFailure } from "./napcatApiTransport.js";
import { boundedBytes } from "./qqMessageMedia.js";
import { putNapcatWebuiObject } from "./napcatWebuiResources.js";
import { napcatWebuiExtendedDescriptors } from "./napcatWebuiExtendedContracts.js";
import { contractFor, ManagementError, callNapcatWebuiManagement as call, checkNapcatWebuiManagementAccount as account, napcatWebuiDigest as digest, selectNapcatWebuiManagementInstance, type NapcatWebuiManagementContext } from "./napcatWebuiManagementOperations.js";
type Row = Record<string, unknown>;
function object(value: unknown): Row {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new ManagementError("RESPONSE_INVALID");
    return value as Row;
}
function readView(id: string, value: unknown): Row {
    if (id === "session.check") {
        if (object(value).authenticated !== true)
            throw new ManagementError("AUTH_OR_OPERATION_REJECTED");
        return { authenticated: true };
    }
    if (id === "releases.latest") {
        if (typeof value !== "string")
            throw new ManagementError("RESPONSE_INVALID");
        return { tag: value };
    }
    const row = object(value);
    if (id === "mirror.test")
        return mirrorResult(row);
    if (id === "plugin.config.summary")
        return {
            supportReactive: row.supportReactive, schemaItems: Array.isArray(row.schema) ? row.schema.length : 0,
            configKeys: Object.keys(object(row.config)).length, protectedContent: true
        };
    if (id === "releases.list") {
        if (!Array.isArray(row.versions))
            throw new ManagementError("RESPONSE_INVALID");
        return { versions: row.versions.map(item => {
                const v = object(item);
                return Object.fromEntries([
                    "tag", "type", "artifactId", "artifactName", "createdAt", "expiresAt", "size", "workflowRunId", "headSha", "workflowTitle"
                ].filter(k => v[k] !== undefined).map(k => [k, v[k]]));
            }), pagination: row.pagination };
    }
    throw new ManagementError("OPERATION_NOT_REGISTERED", 404);
}
function mirrorResult(value: Row): Row {
    if (typeof value.success !== "boolean")
        throw new ManagementError("RESPONSE_INVALID");
    return {
        success: value.success, ...(typeof value.latency === "number" && Number.isFinite(value.latency) && value.latency >= 0 ? { latencyMs: value.latency } : {}), ...(value.error ? { nativeError: true } : {})
    };
}
/** Typed native owners only; no caller-selected native path/action or credential forwarding. */
export function createNapcatWebuiExtendedOperations(context: NapcatWebuiManagementContext): readonly ApiOperationDefinition[] {
    return napcatWebuiExtendedDescriptors.map(spec => {
        const contract = contractFor(spec), compiled = compileApiContract({ contract }), mutation = spec.effects === "configuration-mutation";
        return {
            contract, discovery: { title: `NapCat ${spec.id}`, category: { id: "qq-webui", title: "QQ / NapCat management" } }, handler: async (input) => {
                try {
                    if (input.url.pathname !== contract.pathTemplate || input.url.search || Object.keys(input.path ?? {}).length || Object.keys(input.query ?? {}).length || !compiled.bodyValidator?.(input.body))
                        throw new ManagementError("PARAMETERS_INVALID", 400);
                    if (mutation && context.readOnly())
                        throw new ManagementError("READ_ONLY", 403);
                    const body = input.body as {
                        routeId: string;
                        instanceId: string;
                        params: Row;
                        deliveryId?: string;
                    };
                    const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(qqReadSettings.readTimeoutMs)]) : AbortSignal.timeout(qqReadSettings.readTimeoutMs);
                    const binding = selectNapcatWebuiManagementInstance(context, input.request, body.routeId, body.instanceId, signal), session = await context.openManagementSession(binding, signal);
                    const fence = async () => {
                        const state = await account(session, binding, signal);
                        if (spec.binding === "login-required" && !state.loggedIn)
                            throw new ManagementError("LOGIN_REQUIRED", 409);
                        if (spec.loggedOutOnly && state.loggedIn)
                            throw new ManagementError("LOGOUT_REQUIRED", 409);
                        if (spec.platform) {
                            const platform = object(await call(session, binding, "POST", "/api/QQLogin/GetPlatformInfo", {}, signal));
                            if (platform.platform !== spec.platform)
                                throw new ManagementError("PLATFORM_MISMATCH", 409);
                        }
                    };
                    await fence();
                    const validate = (data: Row) => {
                        if (!compiled.responseValidators.get("200")?.[0]?.body?.({ code: 0, data }))
                            throw new ManagementError("RESPONSE_INVALID");
                        return data;
                    };
                    if (!mutation) {
                        let data: Row;
                        if (spec.stream) {
                            binding.assertCurrent();
                            session.assertCurrent();
                            const response = await session.requestManagement(spec.method, spec.nativePath, body.params, signal);
                            if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream"))
                                throw new ManagementError("RESPONSE_INVALID");
                            const bytes = await boundedBytes(response, qqReadSettings.jsonBytes, "RABIROUTE_QQ_JSON_MAX_BYTES");
                            const results: Row[] = [];
                            let completed = false, failed = 0;
                            for (const block of bytes.toString("utf8").split(/\r?\n\r?\n/)) {
                                const text = block.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
                                if (!text)
                                    continue;
                                const event = object(JSON.parse(text));
                                if (event.type === "error")
                                    throw new ManagementError("NATIVE_STREAM_ERROR");
                                if (event.type === "result") {
                                    if (results.length >= 256)
                                        throw new ManagementError("RESPONSE_INVALID");
                                    const result = mirrorResult(object(event.result));
                                    results.push({ ...result, mirrorIndex: Number.isSafeInteger(event.index) ? event.index : results.length });
                                }
                                if (event.type === "complete") {
                                    completed = true;
                                    failed = Array.isArray(event.failed) ? event.failed.length : 0;
                                }
                            }
                            if (!completed)
                                throw new ManagementError("STREAM_INCOMPLETE");
                            data = {
                                completed, results, failed
                            };
                        }
                        else {
                            let nativeParams = body.params;
                            if (spec.id === "mirror.test") {
                                const list = object(await call(session, binding, "GET", "/api/Mirror/List", {}, signal)), mirrors = list[body.params.type === "raw" ? "rawMirrors" : "fileMirrors"];
                                if (!Array.isArray(mirrors) || typeof mirrors[Number(body.params.mirrorIndex)] !== "string")
                                    throw new ManagementError("MIRROR_SOURCE_UNAVAILABLE", 409);
                                nativeParams = { type: body.params.type, mirror: mirrors[Number(body.params.mirrorIndex)] };
                            }
                            const value = await call(session, binding, spec.method, spec.nativePath, nativeParams, signal);
                            data = readView(spec.id, value);
                            if (spec.id === "plugin.config.summary") {
                                data.artifact = await putNapcatWebuiObject(context, binding, "public-artifact", Buffer.from(JSON.stringify(value)), "application/json", "plugin-config.json");
                            }
                            if (spec.id === "mirror.test")
                                data.mirrorIndex = body.params.mirrorIndex;
                        }
                        await fence();
                        return {
                            status: 200, headers: { "cache-control": "private, no-store" }, body: { code: 0, data: validate(data) }
                        };
                    }
                    const outcome = await session.runBindingOperation(() => executeDurableDelivery({
                        rootDir: context.rootDir, namespace: "napcat-webui-management-v1", deliveryId: body.deliveryId,
                        payload: {
                            operation: spec.id, routeId: body.routeId, instanceId: body.instanceId, expectedUserId: binding.expectedUserId, paramsDigest: digest(body.params)
                        },
                        audit: {
                            operation: spec.id, routeId: body.routeId, instanceId: body.instanceId, expectedUserId: binding.expectedUserId
                        }, requestAuthority: binding.assertCurrent,
                        deliver: async () => {
                            await fence();
                            if (spec.id === "native.release.update") {
                                const native: Row = { targetVersion: body.params.targetVersion, force: body.params.force };
                                if (body.params.mirrorIndex !== undefined) {
                                    const mirrors = object(await call(session, binding, "GET", "/api/Mirror/List", {}, signal)).fileMirrors;
                                    if (!Array.isArray(mirrors) || typeof mirrors[Number(body.params.mirrorIndex)] !== "string")
                                        throw new ManagementError("MIRROR_SOURCE_UNAVAILABLE", 409);
                                    native.mirror = mirrors[Number(body.params.mirrorIndex)];
                                }
                                const result = object(await call(session, binding, "POST", spec.nativePath, native, signal));
                                await fence();
                                if (result.status !== "completed" || typeof result.newVersion !== "string" || !Number.isSafeInteger(result.failedFilesCount) || Number(result.failedFilesCount) < 0)
                                    throw new ManagementError("NATIVE_UPDATE_UNCONFIRMED");
                                return validate({
                                    accepted: true, nativeReadback: false, newVersion: result.newVersion, pendingFileCount: result.failedFilesCount, restartRequired: true, runtimeAdopted: false
                                });
                            }
                            if (spec.stream) {
                                const response = await session.requestManagement(spec.method, spec.nativePath, body.params, signal);
                                if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream"))
                                    throw new ManagementError("RESPONSE_INVALID");
                                const bytes = await boundedBytes(response, qqReadSettings.jsonBytes, "RABIROUTE_QQ_JSON_MAX_BYTES");
                                let success = false;
                                for (const block of bytes.toString("utf8").split(/\r?\n\r?\n/)) {
                                    const text = block.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
                                    if (!text)
                                        continue;
                                    const event = object(JSON.parse(text));
                                    if (event.error)
                                        throw new ManagementError("NATIVE_INSTALL_FAILED");
                                    if (event.success === true)
                                        success = true;
                                }
                                if (!success)
                                    throw new ManagementError("STREAM_INCOMPLETE");
                            }
                            else
                                await call(session, binding, spec.method, spec.nativePath, body.params, signal);
                            let afterDigest: string | undefined;
                            if (spec.readback) {
                                const method = spec.readback.startsWith("/api/NapCatConfig/") ? "GET" : "GET";
                                const value = await call(session, binding, method, spec.readback, {}, signal);
                                if (spec.readback === "/api/Plugin/List") {
                                    const plugins = object(value).plugins;
                                    if (!Array.isArray(plugins) || !plugins.some(p => object(p).id === body.params.id && object(p).status === "active"))
                                        throw new ManagementError("WRITE_READBACK_MISMATCH");
                                }
                                else if (spec.id === "webui-disabled.set") {
                                    if (value !== body.params.disable)
                                        throw new ManagementError("WRITE_READBACK_MISMATCH");
                                }
                                else {
                                    const actual = object(value);
                                    for (const [key, field] of Object.entries(body.params))
                                        if (digest(actual[key]) !== digest(field))
                                            throw new ManagementError("WRITE_READBACK_MISMATCH");
                                }
                                afterDigest = digest(value);
                            }
                            if (!spec.endsSession)
                                await fence();
                            return validate({
                                accepted: true, nativeReadback: Boolean(spec.readback), ...(afterDigest ? { afterDigest } : {}), ...(/^(?:ssl\.|webui-|device\.)/.test(spec.id) ? { restartRequired: true } : {})
                            });
                        }
                    }));
                    binding.assertCurrent();
                    session.assertCurrent();
                    if (outcome.state === "conflict")
                        throw new ManagementError("DELIVERY_CONFLICT", 409);
                    return outcome.state === "completed" ? { status: 200, body: {
                            code: 0, data: outcome.result, delivery: {
                                deliveryId: outcome.deliveryId, state: outcome.state, duplicate: outcome.duplicate, nativeCrossClientCas: false
                            }
                        } }
                        : { status: 202, body: { code: 0, delivery: {
                                    deliveryId: outcome.deliveryId, state: outcome.state, retryable: false, nativeCrossClientCas: false
                                } } };
                }
                catch (error) {
                    return napcatApiFailure(error);
                }
            }
        };
    });
}
