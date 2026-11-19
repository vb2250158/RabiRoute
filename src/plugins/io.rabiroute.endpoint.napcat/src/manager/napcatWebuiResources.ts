import { createHash } from "node:crypto";
import { ManagementError, napcatWebuiDigest as digest, type NapcatWebuiManagementContext, type NapcatWebuiManagementSelection } from "./napcatWebuiManagementOperations.js";
import { projectNapcatWebuiContent } from "./napcatWebuiContentProjection.js";
type Manifest = {
    kind: "napcat-webui-object";
    bytes: number;
    sha256: string;
    contentType: string;
    filename: string;
    redacted?: boolean;
    contentPolicy?: "native-content-redacted/v1";
    chunks: Array<{
        id: string;
        bytes: number;
        sha256: string;
    }>;
};
export const napcatWebuiObjectReferenceSchema = {
    type: "object", additionalProperties: false, required: [
        "id", "bytes", "sha256", "contentType", "filename"
    ],
    properties: {
        id: { type: "string", pattern: "^[a-f0-9]{64}$" }, bytes: { type: "integer", minimum: 0 }, sha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, contentType: {
            type: "string", minLength: 1, maxLength: 256
        }, filename: {
            type: "string", minLength: 1, maxLength: 4096
        }, redacted: { type: "boolean" }, contentPolicy: { const: "native-content-redacted/v1" }
    }
} as const;
export type WebuiObjectReference = {
    id: string;
    bytes: number;
    sha256: string;
    contentType: string;
    filename: string;
    redacted?: boolean;
    contentPolicy?: "native-content-redacted/v1";
};
export function napcatWebuiResourceOwner(binding: NapcatWebuiManagementSelection, purpose: string): string {
    return "napcat.webui." + digest([
        binding.routeId, binding.instanceId, binding.expectedUserId, purpose
    ]);
}
export async function putNapcatWebuiObject(context: NapcatWebuiManagementContext, binding: NapcatWebuiManagementSelection, purpose: string, bytes: Uint8Array, contentType: string, filename: string, projection?: {
    redacted?: boolean;
    sourceFilename?: string;
}): Promise<WebuiObjectReference> {
    let contentPolicy: "native-content-redacted/v1" | undefined;
    if (purpose === "public-artifact") {
        const classified = await projectNapcatWebuiContent(bytes, { filename: projection?.sourceFilename ?? filename });
        bytes = classified.bytes;
        projection = { redacted: Boolean(projection?.redacted || classified.redacted) };
        contentPolicy = "native-content-redacted/v1";
    }
    const store = context.resourceObjects, protectedStore = context.protectedResourceObjects;
    if (!store || !protectedStore)
        throw new ManagementError("RESOURCE_OBJECT_OWNER_UNAVAILABLE");
    const owner = napcatWebuiResourceOwner(binding, purpose), chunks: Manifest["chunks"] = [];
    // Only source-projected public bytes use the public primitive. Every issuer manifest,
    // native path proof and upload input is sealed by the existing local secret owner.
    const isPublic = purpose === "public-artifact";
    const chunkBytes = isPublic ? store.maxObjectBytes : Math.min(262144, Math.floor(store.maxObjectBytes / 4));
    if (chunkBytes < 1)
        throw new ManagementError("RESOURCE_OBJECT_OWNER_INVALID");
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
        binding.assertCurrent();
        const part = bytes.subarray(offset, offset + chunkBytes), sha256 = createHash("sha256").update(part).digest("hex");
        const saved = isPublic ? await store.put(owner, sha256, part, binding.assertCurrent)
            : await protectedStore.putProtected(owner, Buffer.from(part), binding.assertCurrent);
        chunks.push({
            id: saved.id, bytes: part.length, sha256
        });
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex"), manifest: Manifest = {
        kind: "napcat-webui-object", bytes: bytes.length, sha256, contentType, filename, chunks, ...projection, ...(contentPolicy ? { contentPolicy } : {})
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    binding.assertCurrent();
    const { id } = await protectedStore.putProtected(owner, manifestBytes, binding.assertCurrent);
    return {
        id, bytes: bytes.length, sha256, contentType, filename, ...projection, ...(contentPolicy ? { contentPolicy } : {})
    };
}
export async function readNapcatWebuiObject(context: NapcatWebuiManagementContext, binding: NapcatWebuiManagementSelection, purpose: string, id: string): Promise<{
    bytes: Buffer;
    reference: WebuiObjectReference;
}> {
    const store = context.resourceObjects, protectedStore = context.protectedResourceObjects;
    if (!store || !protectedStore)
        throw new ManagementError("RESOURCE_OBJECT_OWNER_UNAVAILABLE");
    binding.assertCurrent();
    let manifest: Manifest;
    const owner = napcatWebuiResourceOwner(binding, purpose);
    try {
        manifest = JSON.parse(Buffer.from(await protectedStore.readProtected(owner, id, binding.assertCurrent)).toString("utf8"));
    }
    catch {
        binding.assertCurrent();
        throw new ManagementError("RESOURCE_OBJECT_NOT_FOUND", 404);
    }
    if (manifest.kind !== "napcat-webui-object" || !Array.isArray(manifest.chunks) || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 0)
        throw new ManagementError("RESOURCE_OBJECT_INVALID");
    const parts: Buffer[] = [];
    for (const chunk of manifest.chunks) {
        binding.assertCurrent();
        const part = Buffer.from(purpose === "public-artifact" ? await store.read(owner, chunk.id)
            : await protectedStore.readProtected(owner, chunk.id, binding.assertCurrent));
        if (part.length !== chunk.bytes || createHash("sha256").update(part).digest("hex") !== chunk.sha256)
            throw new ManagementError("RESOURCE_OBJECT_INVALID");
        parts.push(part);
    }
    const bytes = Buffer.concat(parts);
    binding.assertCurrent();
    if (bytes.length !== manifest.bytes || createHash("sha256").update(bytes).digest("hex") !== manifest.sha256)
        throw new ManagementError("RESOURCE_OBJECT_INVALID");
    return { bytes, reference: {
            id, bytes: manifest.bytes, sha256: manifest.sha256, contentType: manifest.contentType, filename: manifest.filename, ...(manifest.redacted !== undefined ? { redacted: manifest.redacted } : {}), ...(manifest.contentPolicy ? { contentPolicy: manifest.contentPolicy } : {})
        } };
}
/** Internal native path proof; callers must additionally bind their provider to this same original native source. */
export async function resolveNapcatWebuiNativeFileReference(context: NapcatWebuiManagementContext, binding: NapcatWebuiManagementSelection, sourceIdentity: string, id: string): Promise<{
    nativePath: string;
    platform: "win32" | "linux" | "darwin";
    isDirectory: boolean;
    sourceIdentity: string;
}> {
    if (!sourceIdentity)
        throw new ManagementError("NATIVE_FILE_SOURCE_UNAVAILABLE");
    const stored = await readNapcatWebuiObject(context, binding, "native-file-handle", id);
    let value: {
        nativePath?: unknown;
        platform?: unknown;
        isDirectory?: unknown;
        sourceIdentity?: unknown;
    };
    try {
        value = JSON.parse(stored.bytes.toString("utf8"));
    }
    catch {
        throw new ManagementError("FILE_REFERENCE_INVALID", 400);
    }
    if (value.sourceIdentity !== sourceIdentity)
        throw new ManagementError("FILE_SOURCE_CHANGED", 409);
    if (typeof value.nativePath !== "string" || value.nativePath.includes("\0") || ![
        "win32", "linux", "darwin"
    ].includes(String(value.platform)) || typeof value.isDirectory !== "boolean")
        throw new ManagementError("FILE_REFERENCE_INVALID", 400);
    return {
        nativePath: value.nativePath, platform: value.platform as "win32" | "linux" | "darwin", isDirectory: value.isDirectory, sourceIdentity
    };
}
