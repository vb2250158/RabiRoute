import { createHash } from "node:crypto";
import { NapcatApiError } from "../manager/napcatApiTransport.js";
import type { NativeProtectedResourceObjects } from "./protectedObjects.js";
export type NativeResourceObject = Readonly<{
    id: string;
    bytes: number;
    sha256: string;
}>;
export type NativeResourceObjects = Readonly<{
    maxObjectBytes: number;
    put(owner: string, id: string, body: Buffer, authorize: () => void): Promise<NativeResourceObject>;
    read(owner: string, id: string): Promise<Buffer>;
    findByOwner(owner: string): Promise<readonly NativeResourceObject[]>;
}>;
export type NativeArtifactBinding = Readonly<{
    routeId: string;
    instanceId: string;
    botUserId: string;
    action: string;
    deliveryId: string;
    requestDigest?: string;
}>;
export type NativeArtifactReference = Readonly<{
    resourceId: string;
    bytes: number;
    sha256: string;
    name: string;
    mediaType: string;
}>;
type Manifest = NativeArtifactReference & {
    version: 1;
    requestDigest: string;
    chunks: NativeResourceObject[];
};
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const validHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
/** This is an artifact manifest in the shared resource store. The original durable delivery remains the only business ledger. */
export class NapcatArtifactObjects {
    constructor(private readonly resources: NativeResourceObjects, private readonly protectedResources: NativeProtectedResourceObjects) {
        if (!Number.isSafeInteger(resources.maxObjectBytes) || resources.maxObjectBytes < 1)
            throw new Error("Invalid shared resource object bound.");
    }
    private owner(binding: NativeArtifactBinding): string {
        return "napcat-native-artifact:" + hash(JSON.stringify([binding.routeId, binding.instanceId, binding.botUserId, binding.action, binding.deliveryId]));
    }
    private async manifest(binding: NativeArtifactBinding, resourceId: string, authorize: () => void): Promise<Manifest> {
        if (!validHash(resourceId))
            throw new NapcatApiError(400, "QQ_NATIVE_RESOURCE_ID_INVALID");
        authorize();
        const bytes = await this.protectedResources.readProtected(this.owner(binding), resourceId, authorize);
        authorize();
        let value: Manifest;
        try {
            value = JSON.parse(bytes.toString("utf8")) as Manifest;
        }
        catch {
            throw new NapcatApiError(503, "QQ_NATIVE_RESOURCE_MANIFEST_INVALID");
        }
        if (!value || value.version !== 1 || !validHash(value.requestDigest) || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || !validHash(value.sha256)
            || typeof value.name !== "string" || !/^[a-zA-Z0-9_.-]{1,80}$/.test(value.name)
            || value.mediaType !== "application/octet-stream" || !Array.isArray(value.chunks)
            || value.chunks.some(chunk => !chunk || !validHash(chunk.id) || chunk.sha256 !== chunk.id
                || !Number.isSafeInteger(chunk.bytes) || chunk.bytes < 1 || chunk.bytes > this.resources.maxObjectBytes)
            || value.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0) !== value.bytes) {
            throw new NapcatApiError(503, "QQ_NATIVE_RESOURCE_MANIFEST_INVALID");
        }
        if (binding.requestDigest && value.requestDigest !== binding.requestDigest)
            throw new NapcatApiError(409, "QQ_NATIVE_RESOURCE_INTENT_CONFLICT");
        return { ...value, resourceId };
    }
    async put(binding: NativeArtifactBinding, body: Buffer, name: string, authorize: () => void): Promise<NativeArtifactReference> {
        return this.putStream(binding, async (write) => {
            await write(body);
        }, name, authorize);
    }
    async putStream(binding: NativeArtifactBinding, consume: (write: (bytes: Uint8Array) => Promise<void>) => Promise<void>, name: string, authorize: () => void): Promise<NativeArtifactReference> {
        if (!validHash(binding.requestDigest) || !/^[a-zA-Z0-9_.-]{1,80}$/.test(name))
            throw new NapcatApiError(400, "QQ_NATIVE_RESOURCE_METADATA_INVALID");
        const owner = this.owner(binding), chunks: NativeResourceObject[] = [];
        const hashState = createHash("sha256");
        let total = 0;
        let pending = Buffer.alloc(this.resources.maxObjectBytes);
        let pendingBytes = 0;
        const flush = async () => {
            if (!pendingBytes)
                return;
            authorize();
            const bytes = pending.subarray(0, pendingBytes), id = hash(bytes);
            const stored = await this.resources.put(owner + ":chunks", id, bytes, authorize);
            authorize();
            if (stored.id !== id || stored.sha256 !== id || stored.bytes !== bytes.length)
                throw new NapcatApiError(503, "QQ_NATIVE_RESOURCE_STORE_INVALID");
            chunks.push({ id, bytes: bytes.length, sha256: id });
            pending = Buffer.alloc(this.resources.maxObjectBytes);
            pendingBytes = 0;
        };
        await consume(async (value) => {
            authorize();
            total += value.length;
            if (!Number.isSafeInteger(total))
                throw new NapcatApiError(413, "QQ_NATIVE_RESOURCE_TOO_LARGE");
            hashState.update(value);
            let offset = 0;
            while (offset < value.length) {
                const count = Math.min(pending.length - pendingBytes, value.length - offset);
                pending.set(value.subarray(offset, offset + count), pendingBytes);
                pendingBytes += count;
                offset += count;
                if (pendingBytes === pending.length)
                    await flush();
            }
        });
        await flush();
        const manifest = { version: 1, requestDigest: binding.requestDigest, bytes: total, sha256: hashState.digest("hex"), name, mediaType: "application/octet-stream", chunks };
        const bytes = Buffer.from(JSON.stringify(manifest));
        if (bytes.length > this.resources.maxObjectBytes)
            throw new NapcatApiError(413, "QQ_NATIVE_RESOURCE_MANIFEST_TOO_LARGE");
        const saved = await this.protectedResources.putProtected(owner, bytes, authorize);
        if (!validHash(saved.id) || !saved.durable)
            throw new NapcatApiError(503, "QQ_NATIVE_RESOURCE_MANIFEST_UNCONFIRMED");
        authorize();
        return { resourceId: saved.id, bytes: total, sha256: manifest.sha256, name, mediaType: manifest.mediaType };
    }
    async openStream(binding: NativeArtifactBinding, resourceId: string, maxBytes: number, authorize: () => void) {
        const manifest = await this.manifest(binding, resourceId, authorize);
        if (manifest.bytes > maxBytes)
            throw new NapcatApiError(413, "QQ_NATIVE_RESOURCE_TOO_LARGE");
        const resources = this.resources;
        const chunkOwner = this.owner(binding) + ":chunks";
        const frames = (async function* () {
            const completeHash = createHash("sha256");
            for (const chunk of manifest.chunks) {
                authorize();
                const bytes = await resources.read(chunkOwner, chunk.id);
                authorize();
                if (bytes.length !== chunk.bytes || hash(bytes) !== chunk.sha256)
                    throw new NapcatApiError(503, "QQ_NATIVE_RESOURCE_CHANGED");
                completeHash.update(bytes);
                yield bytes;
            }
            if (completeHash.digest("hex") !== manifest.sha256)
                throw new NapcatApiError(503, "QQ_NATIVE_RESOURCE_CHANGED");
        })();
        return { reference: { resourceId, bytes: manifest.bytes, sha256: manifest.sha256, name: manifest.name, mediaType: manifest.mediaType }, frames };
    }
    async read(binding: NativeArtifactBinding, resourceId: string, maxBytes: number, authorize: () => void): Promise<{
        reference: NativeArtifactReference;
        bytes: Buffer;
    }> {
        const manifest = await this.manifest(binding, resourceId, authorize);
        if (manifest.bytes > maxBytes)
            throw new NapcatApiError(413, "QQ_NATIVE_RESOURCE_TOO_LARGE");
        const chunks: Buffer[] = [];
        for (const chunk of manifest.chunks) {
            authorize();
            const bytes = await this.resources.read(this.owner(binding) + ":chunks", chunk.id);
            authorize();
            if (bytes.length !== chunk.bytes || hash(bytes) !== chunk.sha256)
                throw new NapcatApiError(503, "QQ_NATIVE_RESOURCE_CHANGED");
            chunks.push(bytes);
        }
        const bytes = Buffer.concat(chunks, manifest.bytes);
        if (hash(bytes) !== manifest.sha256)
            throw new NapcatApiError(503, "QQ_NATIVE_RESOURCE_CHANGED");
        const { resourceId: id, name, mediaType, sha256 } = manifest;
        return { reference: { resourceId: id, bytes: bytes.length, sha256, name, mediaType }, bytes };
    }
    async findAndRead(binding: NativeArtifactBinding, maxBytes: number, authorize: () => void): Promise<{
        reference: NativeArtifactReference;
        bytes: Buffer;
    } | undefined> {
        authorize();
        const candidates = await this.protectedResources.findByOwner(this.owner(binding), authorize);
        authorize();
        if (!candidates.length)
            return;
        if (candidates.length !== 1)
            throw new NapcatApiError(503, "QQ_NATIVE_RESOURCE_OWNER_CONFLICT");
        return this.read(binding, candidates[0]!.id, maxBytes, authorize);
    }
    async find(binding: NativeArtifactBinding, maxBytes: number, authorize: () => void): Promise<NativeArtifactReference | undefined> {
        authorize();
        const candidates = await this.protectedResources.findByOwner(this.owner(binding), authorize);
        authorize();
        if (!candidates.length)
            return;
        if (candidates.length !== 1)
            throw new NapcatApiError(503, "QQ_NATIVE_RESOURCE_OWNER_CONFLICT");
        const original = await this.openStream(binding, candidates[0].id, maxBytes, authorize);
        for await (const _ of original.frames) { /* Every original chunk is verified without materializing the object. */
        }
        return original.reference;
    }
}
