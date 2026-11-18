import { createHash } from "node:crypto";
import { NapcatApiError, type NapcatApiSelection } from "../manager/napcatApiTransport.js";
import type { NativeProtectedResourceObjects } from "./protectedObjects.js";
export type NativeFileAction = "download_file" | "upload_file_stream";
export type NativeFileReference = Readonly<{
    id: string;
    action: NativeFileAction;
    deliveryId: string;
    bytes: number;
    sha256: string;
    name: string;
}>;
type NativeFileManifest = NativeFileReference & {
    version: 1;
    nativePath: string;
    requestDigest: string;
};
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const hashPattern = /^[a-f0-9]{64}$/;
/** Native paths are private resource metadata in the same existing cache, not a new file store or business ledger. */
export class NapcatNativeFileHandles {
    constructor(private readonly resources: NativeProtectedResourceObjects) {
    }
    private owner(selection: NapcatApiSelection, action: NativeFileAction, deliveryId: string) {
        const source = [selection.routeId, selection.instanceId, selection.botUserId, selection.httpUrl, digest(selection.accessToken), action, deliveryId];
        return "napcat-native-file:" + digest(JSON.stringify(source));
    }
    async put(selection: NapcatApiSelection, action: NativeFileAction, deliveryId: string, value: {
        nativePath: string;
        requestDigest: string;
        bytes: number;
        sha256: string;
        name: string;
    }): Promise<NativeFileReference> {
        selection.assertCurrent();
        if (!value.nativePath || /[\x00-\x1f\x7f]/.test(value.nativePath) || !hashPattern.test(value.requestDigest)
            || !hashPattern.test(value.sha256) || !Number.isSafeInteger(value.bytes) || value.bytes < 0) {
            throw new NapcatApiError(503, "QQ_NATIVE_FILE_RESULT_INVALID");
        }
        const manifest = { version: 1, action, deliveryId, ...value };
        const bytes = Buffer.from(JSON.stringify(manifest));
        const stored = await this.resources.putProtected(this.owner(selection, action, deliveryId), bytes, selection.assertCurrent);
        selection.assertCurrent();
        if (!hashPattern.test(stored.id) || !stored.durable) {
            throw new NapcatApiError(503, "QQ_NATIVE_FILE_METADATA_INTEGRITY_FAILED");
        }
        return { id: stored.id, action, deliveryId, bytes: value.bytes, sha256: value.sha256, name: value.name };
    }
    async read(selection: NapcatApiSelection, reference: Pick<NativeFileReference, "id" | "action" | "deliveryId">, requestDigest?: string): Promise<NativeFileManifest> {
        selection.assertCurrent();
        if (!hashPattern.test(reference.id) || !["download_file", "upload_file_stream"].includes(reference.action)
            || typeof reference.deliveryId !== "string" || !reference.deliveryId) {
            throw new NapcatApiError(400, "QQ_NATIVE_FILE_REFERENCE_INVALID");
        }
        const bytes = await this.resources.readProtected(this.owner(selection, reference.action, reference.deliveryId), reference.id, selection.assertCurrent);
        selection.assertCurrent();
        let value: NativeFileManifest;
        try {
            value = JSON.parse(bytes.toString("utf8"));
        }
        catch {
            throw new NapcatApiError(503, "QQ_NATIVE_FILE_METADATA_INVALID");
        }
        if (value.version !== 1 || value.action !== reference.action || value.deliveryId !== reference.deliveryId
            || typeof value.nativePath !== "string" || !value.nativePath || /[\x00-\x1f\x7f]/.test(value.nativePath)
            || !hashPattern.test(value.requestDigest) || !hashPattern.test(value.sha256) || typeof value.name !== "string"
            || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || requestDigest !== undefined && value.requestDigest !== requestDigest) {
            throw new NapcatApiError(503, "QQ_NATIVE_FILE_METADATA_INVALID");
        }
        return { ...value, id: reference.id };
    }
    async findOriginal(selection: NapcatApiSelection, action: NativeFileAction, deliveryId: string, requestDigest: string): Promise<NativeFileReference | undefined> {
        selection.assertCurrent();
        const objects = await this.resources.findByOwner(this.owner(selection, action, deliveryId), selection.assertCurrent);
        selection.assertCurrent();
        if (objects.length === 0)
            return undefined;
        if (objects.length !== 1)
            throw new NapcatApiError(503, "QQ_NATIVE_FILE_OWNER_CONFLICT");
        const value = await this.read(selection, { id: objects[0].id, action, deliveryId }, requestDigest);
        return { id: value.id, action, deliveryId, bytes: value.bytes, sha256: value.sha256, name: value.name };
    }
}
