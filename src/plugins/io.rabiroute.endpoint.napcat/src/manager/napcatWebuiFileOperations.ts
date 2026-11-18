import path from "node:path";
import type { ApiOperationDefinition, ApiOperationResult } from "@rabiroute/host-api/manager/apiOperationContract";
import { compileApiContract } from "@rabiroute/host-api/manager/apiOperationContract";
import { executeDurableDelivery } from "@rabiroute/host-api/manager/durableDeliveryIdempotency";
import { qqReadSettings } from "@rabiroute/host-api/shared/qqReadSettings";
import { contractFor, ManagementError, callNapcatWebuiManagement as call, checkNapcatWebuiManagementAccount as account, napcatWebuiDigest as digest, selectNapcatWebuiManagementInstance, type NapcatWebuiManagementContext } from "./napcatWebuiManagementOperations.js";
import { putNapcatWebuiObject, readNapcatWebuiObject, resolveNapcatWebuiNativeFileReference, napcatWebuiObjectReferenceSchema } from "./napcatWebuiResources.js";
import { projectNapcatConfigImport } from "./napcatWebuiConfigArchive.js";
import { boundedBytes } from "./qqMessageMedia.js";
import { napcatApiFailure } from "./napcatApiTransport.js";
const sourceLocations: Record<string, {
    route: number;
    handlers: number[];
}> = {
    "GET /api/File/list": { "route": 91990, "handlers": [91577] }, "GET /api/File/read": { "route": 91993, "handlers": [91706] }, "POST /api/File/download": { "route": 92000, "handlers": [91840] }, "POST /api/File/batchDownload": { "route": 92001, "handlers": [91876] }, "POST /api/File/create": { "route": 91995, "handlers": [91757] }, "POST /api/File/mkdir": { "route": 91991, "handlers": [91637] }, "POST /api/File/delete": { "route": 91992, "handlers": [91658] }, "POST /api/File/batchDelete": { "route": 91996, "handlers": [91681] }, "POST /api/File/move": { "route": 91998, "handlers": [91798] }, "POST /api/File/rename": { "route": 91997, "handlers": [91778] }, "POST /api/File/batchMove": { "route": 91999, "handlers": [91818] }, "POST /api/File/write": { "route": 91994, "handlers": [91726] }, "POST /api/File/upload": { "route": 92002, "handlers": [91911] }, "POST /api/File/font/upload/webui": { "route": 92003, "handlers": [91934] }, "POST /api/File/font/delete/webui": { "route": 92004, "handlers": [91957] }, "GET /api/OB11Config/ExportConfig": { "route": 70853, "handlers": [70740] }, "POST /api/OB11Config/ImportConfig": { "route": 70854, "handlers": [70807] }
};
type Row = Record<string, unknown>;
const text = {
    type: "string", minLength: 1, maxLength: 4096
} as const, ref = {
    type: "string", minLength: 1, maxLength: 256
} as const;
const closed = (properties: Row, required: string[] = []) => ({
    type: "object", additionalProperties: false, properties, required
});
const artifact = napcatWebuiObjectReferenceSchema;
const source = closed({ fileRef: ref }, ["fileRef"]), target = closed({ fileRef: ref, targetPath: text }, ["fileRef", "targetPath"]);
const specs = [
    {
        id: "file.list", method: "GET", native: "/api/File/list", params: closed({
            nativePath: text, fileRef: ref, onlyDirectory: { type: "boolean" }
        }), mutation: false
    },
    {
        id: "file.read", method: "GET", native: "/api/File/read", params: source, mutation: false
    },
    {
        id: "file.download", method: "POST", native: "/api/File/download", params: source, mutation: false, binary: true
    },
    {
        id: "file.batch-download", method: "POST", native: "/api/File/batchDownload", params: closed({ fileRefs: {
                type: "array", minItems: 1, items: ref
            } }, ["fileRefs"]), mutation: false, binary: true
    },
    {
        id: "file.create", method: "POST", native: "/api/File/create", params: closed({ nativePath: text }, ["nativePath"]), mutation: true
    },
    {
        id: "file.mkdir", method: "POST", native: "/api/File/mkdir", params: closed({ nativePath: text }, ["nativePath"]), mutation: true
    },
    {
        id: "file.delete", method: "POST", native: "/api/File/delete", params: source, mutation: true
    },
    {
        id: "file.batch-delete", method: "POST", native: "/api/File/batchDelete", params: closed({ fileRefs: {
                type: "array", minItems: 1, items: ref
            } }, ["fileRefs"]), mutation: true
    },
    {
        id: "file.move", method: "POST", native: "/api/File/move", params: target, mutation: true
    },
    {
        id: "file.rename", method: "POST", native: "/api/File/rename", params: target, mutation: true
    },
    {
        id: "file.batch-move", method: "POST", native: "/api/File/batchMove", params: closed({ items: {
                type: "array", minItems: 1, items: target
            } }, ["items"]), mutation: true
    },
    {
        id: "file.write", method: "POST", native: "/api/File/write", params: closed({ fileRef: ref, artifactId: ref }, ["fileRef", "artifactId"]), mutation: true
    },
    {
        id: "file.upload", method: "POST", native: "/api/File/upload", params: closed({ nativePath: text, files: {
                type: "array", minItems: 1, maxItems: 20, items: closed({ artifactId: ref, filename: text }, ["artifactId", "filename"])
            } }, ["nativePath", "files"]), mutation: true, multipart: true
    },
    {
        id: "font.upload", method: "POST", native: "/api/File/font/upload/webui", params: closed({ artifactId: ref, filename: text }, ["artifactId", "filename"]), mutation: true, multipart: true
    },
    {
        id: "font.delete", method: "POST", native: "/api/File/font/delete/webui", params: closed({}), mutation: true
    },
    {
        id: "onebot.config.export", method: "GET", native: "/api/OB11Config/ExportConfig", params: closed({}), mutation: false, binary: true
    },
    {
        id: "onebot.config.import", method: "POST", native: "/api/OB11Config/ImportConfig", params: closed({ artifactId: ref }, ["artifactId"]), mutation: true, multipart: true
    },
    {
        id: "file.artifact.stage", method: "POST", native: "", params: closed({
            contentBase64: { type: "string" }, filename: text, contentType: ref
        }, [
            "contentBase64", "filename", "contentType"
        ]), mutation: true
    },
    {
        id: "file.artifact.read", method: "GET", native: "", params: closed({ artifactId: ref }, ["artifactId"]), mutation: false
    }
] as const;
export const napcatWebuiFileNativeActions = specs.filter(spec => spec.native).map(spec => ({
    id: spec.id, method: spec.method, nativePath: spec.native
}));
export function createNapcatWebuiFileOperations(context: NapcatWebuiManagementContext): readonly ApiOperationDefinition[] {
    return specs.map(spec => {
        let contract = contractFor({
            id: spec.id, method: spec.method, nativePath: spec.native, params: spec.params, response: closed({
                accepted: { type: "boolean" }, nativeReadback: { type: "boolean" }, artifact, entries: { type: "array", items: closed({
                        name: text, fileRef: ref, isDirectory: { type: "boolean" }, bytes: { type: "number" }, modifiedAt: { type: "string" }
                    }, [
                        "name", "fileRef", "isDirectory"
                    ]) }, preservedCredentialFields: { type: "integer" }
            }, []), binding: "management-bootstrap", effects: spec.mutation ? "configuration-mutation" : "none", description: "Fixed authenticated native WebUI filesystem owner. Paths are interpreted only by the selected native host/platform, never Manager fs. Existing list entries issue account-bound opaque refs. Public content is credential-projected and reports its actual returned bytes/hash and redacted status; ordinary non-sensitive bytes remain unchanged. Uploaded input is write-only to public artifact reads. Batch failure may be partial; original unknown receipts never replay. Config import rejects ZIP escape/symlinks and retains original token/SSL key values.", sourceLines: sourceLocations[spec.method + " " + spec.native] ?? { route: 0, handlers: [] }
        });
        if (spec.id === "file.artifact.read")
            contract = { ...contract, responses: { "200": { mediaType: "application/octet-stream", binary: { minBytes: 0, maxBytes: qqReadSettings.mediaBytes } }, default: contract.responses.default! } };
        const compiled = compileApiContract({ contract });
        return {
            contract, discovery: { title: `NapCat ${spec.id}`, category: { id: "qq-webui", title: "QQ / NapCat management" } }, handler: async (input): Promise<ApiOperationResult> => {
                try {
                    if (input.url.pathname !== contract.pathTemplate || input.url.search || Object.keys(input.path ?? {}).length || Object.keys(input.query ?? {}).length || !compiled.bodyValidator?.(input.body))
                        throw new ManagementError("PARAMETERS_INVALID", 400);
                    if (spec.mutation && context.readOnly())
                        throw new ManagementError("READ_ONLY", 403);
                    const body = input.body as {
                        routeId: string;
                        instanceId: string;
                        params: Row;
                        deliveryId?: string;
                    }, params = body.params;
                    const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(qqReadSettings.mediaTimeoutMs)]) : AbortSignal.timeout(qqReadSettings.mediaTimeoutMs);
                    const binding = selectNapcatWebuiManagementInstance(context, input.request, body.routeId, body.instanceId, signal);
                    if (spec.id === "file.artifact.read") {
                        const stored = await readNapcatWebuiObject(context, binding, "public-artifact", String(params.artifactId));
                        binding.assertCurrent();
                        if (stored.reference.contentPolicy !== "native-content-redacted/v1")
                            throw new ManagementError("CONTENT_OWNER_REQUIRED", 409);
                        if (stored.bytes.length > qqReadSettings.mediaBytes)
                            throw new ManagementError("ARTIFACT_READ_BUDGET", 413);
                        return {
                            status: 200, headers: {
                                "content-type": "application/octet-stream", "cache-control": "private, no-store", "content-length": String(stored.bytes.length), "x-content-type-options": "nosniff"
                            }, body: stored.bytes
                        };
                    }
                    const session = await context.openManagementSession(binding, signal);
                    await account(session, binding, signal);
                    const platform = (await call(session, binding, "POST", "/api/QQLogin/GetPlatformInfo", {}, signal) as Row).platform;
                    if (platform !== "win32" && platform !== "linux" && platform !== "darwin")
                        throw new ManagementError("PLATFORM_UNAVAILABLE");
                    const nativePath = platform === "win32" ? path.win32 : path.posix;
                    const validatePath = (value: unknown) => {
                        if (typeof value !== "string" || !value || value.includes("\0") || !nativePath.isAbsolute(value))
                            throw new ManagementError("NATIVE_PATH_INVALID", 400);
                        return value;
                    };
                    if (!session.sourceIdentity)
                        throw new ManagementError("NATIVE_FILE_SOURCE_UNAVAILABLE");
                    const readHandle = async (id: unknown) => {
                        const handle = await resolveNapcatWebuiNativeFileReference(context, binding, session.sourceIdentity!, String(id));
                        if (handle.platform !== platform)
                            throw new ManagementError("FILE_PLATFORM_CHANGED", 409);
                        return { nativePath: validatePath(handle.nativePath), isDirectory: handle.isDirectory };
                    };
                    const execute = async (): Promise<Row> => {
                        await account(session, binding, signal);
                        let nativeParams: Row = {}, preservedCredentialFields: number | undefined;
                        if (spec.id === "file.artifact.stage") {
                            const bytes = Buffer.from(String(params.contentBase64), "base64");
                            if (bytes.toString("base64") !== params.contentBase64 || bytes.length > qqReadSettings.mediaBytes)
                                throw new ManagementError("ARTIFACT_INPUT_INVALID", 400);
                            return { artifact: await putNapcatWebuiObject(context, binding, "input", bytes, String(params.contentType), String(params.filename)) };
                        }
                        if (spec.id === "file.list")
                            nativeParams = { ...(params.nativePath ? { path: validatePath(params.nativePath) } : params.fileRef ? { path: (await readHandle(params.fileRef)).nativePath } : { path: "/" }), ...(params.onlyDirectory !== undefined ? { onlyDirectory: params.onlyDirectory } : {}) };
                        else if (spec.id === "file.create" || spec.id === "file.mkdir")
                            nativeParams = { path: validatePath(params.nativePath) };
                        else if (spec.id === "file.batch-delete" || spec.id === "file.batch-download")
                            nativeParams = { paths: await Promise.all((params.fileRefs as string[]).map(async (id) => (await readHandle(id)).nativePath)) };
                        else if (spec.id === "file.batch-move")
                            nativeParams = { items: await Promise.all((params.items as Row[]).map(async (item) => ({ sourcePath: (await readHandle(item.fileRef)).nativePath, targetPath: validatePath(item.targetPath) }))) };
                        else if (spec.id === "file.move" || spec.id === "file.rename") {
                            const from = (await readHandle(params.fileRef)).nativePath;
                            nativeParams = spec.id === "file.move" ? { sourcePath: from, targetPath: validatePath(params.targetPath) } : { oldPath: from, newPath: validatePath(params.targetPath) };
                        }
                        else if (params.fileRef)
                            nativeParams = { path: (await readHandle(params.fileRef)).nativePath };
                        if (spec.id === "file.write") {
                            const content = await readNapcatWebuiObject(context, binding, "input", String(params.artifactId));
                            nativeParams.content = content.bytes.toString("utf8");
                        }
                        let response: Response | undefined, value: unknown;
                        if ("multipart" in spec && spec.multipart) {
                            if (!session.requestMultipart)
                                throw new ManagementError("MULTIPART_OWNER_UNAVAILABLE");
                            const inputs = spec.id === "file.upload" ? params.files as Row[] : [params];
                            const files = [];
                            for (const part of inputs) {
                                const content = await readNapcatWebuiObject(context, binding, "input", String(part.artifactId));
                                let bytes = content.bytes;
                                if (spec.id === "onebot.config.import") {
                                    const exported = await session.requestManagement("GET", "/api/OB11Config/ExportConfig", {}, signal), current = await boundedBytes(exported, qqReadSettings.mediaBytes, "RABIROUTE_QQ_MEDIA_MAX_BYTES", true);
                                    const projected = await projectNapcatConfigImport(bytes, current);
                                    bytes = projected.bytes;
                                    preservedCredentialFields = projected.preservedCredentialFields;
                                }
                                const filename = spec.id === "onebot.config.import" ? "config.zip" : String(part.filename);
                                if (nativePath.basename(filename) !== filename || /[\\/\0]/.test(filename))
                                    throw new ManagementError("FILENAME_INVALID", 400);
                                files.push({
                                    field: spec.id === "file.upload" ? "files" : spec.id === "font.upload" ? "file" : "configFile", filename, bytes
                                });
                            }
                            await account(session, binding, signal);
                            response = await session.requestMultipart(spec.native, spec.id === "file.upload" ? { path: validatePath(params.nativePath) } : {}, files, signal);
                            const envelope = JSON.parse((await boundedBytes(response, qqReadSettings.jsonBytes, "RABIROUTE_QQ_JSON_MAX_BYTES")).toString("utf8"));
                            if (!response.ok || envelope.code !== 0)
                                throw new ManagementError("NATIVE_FILE_OPERATION_REJECTED");
                            value = envelope.data;
                        }
                        else if ("binary" in spec && spec.binary) {
                            response = await session.requestManagement(spec.method, spec.native, nativeParams, signal);
                            const bytes = await boundedBytes(response, qqReadSettings.mediaBytes, "RABIROUTE_QQ_MEDIA_MAX_BYTES", true);
                            await account(session, binding, signal);
                            return { artifact: await putNapcatWebuiObject(context, binding, "public-artifact", bytes, response.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream", spec.id === "onebot.config.export" ? "config.zip" : "download.bin", { sourceFilename: typeof nativeParams.path === "string" ? nativePath.basename(nativeParams.path) : undefined }) };
                        }
                        else
                            value = await call(session, binding, spec.method, spec.native, nativeParams, signal);
                        await account(session, binding, signal);
                        if (spec.id === "file.list") {
                            if (!Array.isArray(value))
                                throw new ManagementError("RESPONSE_INVALID");
                            const entries = [];
                            for (const item of value) {
                                if (!item || typeof item !== "object")
                                    continue;
                                const row = item as Row;
                                if (typeof row.name !== "string" || row.name === "." || row.name === ".." || typeof row.isDirectory !== "boolean")
                                    continue;
                                let entryPath: string;
                                if (platform === "win32" && /^[a-z]:$/i.test(row.name))
                                    entryPath = row.name + "\\";
                                else if (nativeParams.path)
                                    entryPath = nativePath.join(String(nativeParams.path), row.name);
                                else
                                    continue;
                                if (nativePath.basename(row.name) !== row.name && !(platform === "win32" && /^[a-z]:$/i.test(row.name)))
                                    continue;
                                const saved = await putNapcatWebuiObject(context, binding, "native-file-handle", Buffer.from(JSON.stringify({
                                    nativePath: entryPath, platform, sourceIdentity: session.sourceIdentity, isDirectory: row.isDirectory
                                })), "application/json", "native-file-handle.json");
                                entries.push({
                                    name: row.name, fileRef: saved.id, isDirectory: row.isDirectory, ...(typeof row.size === "number" ? { bytes: row.size } : {}), ...(typeof row.mtime === "string" ? { modifiedAt: row.mtime } : {})
                                });
                            }
                            return { entries };
                        }
                        if (spec.id === "file.read") {
                            if (typeof value !== "string")
                                throw new ManagementError("RESPONSE_INVALID");
                            return { artifact: await putNapcatWebuiObject(context, binding, "public-artifact", Buffer.from(value), "text/plain", "content.txt", { sourceFilename: typeof nativeParams.path === "string" ? nativePath.basename(nativeParams.path) : undefined }) };
                        }
                        return {
                            accepted: true, nativeReadback: false, ...(preservedCredentialFields !== undefined ? { preservedCredentialFields } : {})
                        };
                    };
                    if (!spec.mutation)
                        return {
                            status: 200, headers: { "cache-control": "private, no-store" }, body: { code: 0, data: await execute() }
                        };
                    const outcome = await session.runBindingOperation(() => executeDurableDelivery({
                        rootDir: context.rootDir, namespace: "napcat-webui-management-v1", deliveryId: body.deliveryId, payload: {
                            operation: spec.id, routeId: body.routeId, instanceId: body.instanceId, expectedUserId: binding.expectedUserId, paramsDigest: digest(params)
                        }, audit: {
                            operation: spec.id, routeId: body.routeId, instanceId: body.instanceId, expectedUserId: binding.expectedUserId
                        }, requestAuthority: binding.assertCurrent, deliver: execute
                    }));
                    if (outcome.state === "conflict")
                        throw new ManagementError("DELIVERY_CONFLICT", 409);
                    return outcome.state === "completed" ? { status: 200, body: {
                            code: 0, data: outcome.result, delivery: {
                                deliveryId: outcome.deliveryId, state: outcome.state, duplicate: outcome.duplicate, nativeCrossClientCas: false
                            }
                        } } : { status: 202, body: { code: 0, delivery: {
                                deliveryId: outcome.deliveryId, state: outcome.state, retryable: false
                            } } };
                }
                catch (error) {
                    return napcatApiFailure(error);
                }
            }
        };
    });
}
