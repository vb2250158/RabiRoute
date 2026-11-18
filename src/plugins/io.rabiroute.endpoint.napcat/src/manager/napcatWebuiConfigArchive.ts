import * as yauzl from "yauzl";
import { ManagementError } from "./napcatWebuiManagementOperations.js";
import { qqReadSettings } from "@rabiroute/host-api/shared/qqReadSettings";
import { isNapcatCredentialField, hasNapcatProtectedMarker } from "./napcatWebuiSecrets.js";
const crcTable = Array.from({ length: 256 }, (_, n) => {
    for (let i = 0; i < 8; i++)
        n = (n & 1) ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
});
const crc32 = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const b of bytes)
        c = crcTable[(c ^ b) & 255]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
};
export async function readNapcatConfigArchive(bytes: Buffer, options: {
    flat?: boolean;
} = {}): Promise<Map<string, Buffer>> {
    const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (err, result) => err || !result ? reject(err ?? new ManagementError("CONFIG_ARCHIVE_INVALID")) : resolve(result)));
    return new Promise((resolve, reject) => {
        const files = new Map<string, Buffer>();
        let total = 0;
        const fail = (e: unknown) => {
            zip.close();
            reject(e);
        };
        zip.on("error", fail);
        zip.on("end", () => resolve(files));
        zip.on("entry", (entry: yauzl.Entry) => {
            // The matching native export is flat; reject archive names the native prefix check cannot safely own.
            if (!entry.fileName || (options.flat !== false && (/[\\/\0:]/.test(entry.fileName) || entry.fileName === "." || entry.fileName === ".." || (entry.externalFileAttributes >>> 16 & 0xf000) === 0xa000)) || files.has(entry.fileName)) {
                fail(new ManagementError("CONFIG_ARCHIVE_PATH_INVALID", 400));
                return;
            }
            total += entry.uncompressedSize;
            if (total > qqReadSettings.mediaBytes) {
                fail(new ManagementError("CONFIG_ARCHIVE_BUDGET", 413));
                return;
            }
            zip.openReadStream(entry, (error, stream) => {
                if (error || !stream) {
                    fail(new ManagementError("CONFIG_ARCHIVE_INVALID", 400));
                    return;
                }
                const chunks: Buffer[] = [];
                let size = 0;
                stream.on("data", (chunk: Buffer) => {
                    size += chunk.length;
                    if (size > entry.uncompressedSize) {
                        stream.destroy();
                        fail(new ManagementError("CONFIG_ARCHIVE_INVALID", 400));
                    }
                    else
                        chunks.push(chunk);
                });
                stream.on("error", fail);
                stream.on("end", () => {
                    files.set(entry.fileName, Buffer.concat(chunks));
                    zip.readEntry();
                });
            });
        });
        zip.readEntry();
    });
}
/** Stored ZIP entries preserve original JSON/file bytes except the explicitly projected credential fields. */
export function writeNapcatConfigArchive(files: ReadonlyMap<string, Buffer>): Buffer {
    const local: Buffer[] = [], central: Buffer[] = [];
    let offset = 0;
    for (const [name, bytes] of files) {
        const filename = Buffer.from(name), checksum = crc32(bytes), head = Buffer.alloc(30);
        head.writeUInt32LE(0x04034b50);
        head.writeUInt16LE(20, 4);
        head.writeUInt16LE(0x800, 6);
        head.writeUInt32LE(checksum, 14);
        head.writeUInt32LE(bytes.length, 18);
        head.writeUInt32LE(bytes.length, 22);
        head.writeUInt16LE(filename.length, 26);
        local.push(head, filename, bytes);
        const c = Buffer.alloc(46);
        c.writeUInt32LE(0x02014b50);
        c.writeUInt16LE(20, 4);
        c.writeUInt16LE(20, 6);
        c.writeUInt16LE(0x800, 8);
        c.writeUInt32LE(checksum, 16);
        c.writeUInt32LE(bytes.length, 20);
        c.writeUInt32LE(bytes.length, 24);
        c.writeUInt16LE(filename.length, 28);
        c.writeUInt32LE(offset, 42);
        central.push(c, filename);
        offset += head.length + filename.length + bytes.length;
    }
    const dir = Buffer.concat(central), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(files.size, 8);
    end.writeUInt16LE(files.size, 10);
    end.writeUInt32LE(dir.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([
        ...local, dir, end
    ]);
}
export async function projectNapcatConfigImport(input: Buffer, current: Buffer): Promise<{
    bytes: Buffer;
    preservedCredentialFields: number;
}> {
    const requested = await readNapcatConfigArchive(input), existing = await readNapcatConfigArchive(current);
    let preservedCredentialFields = 0;
    if (!requested.size)
        throw new ManagementError("CONFIG_ARCHIVE_EMPTY", 400);
    const preserve = (next: unknown, original: unknown): unknown => {
        if (Array.isArray(next) && Array.isArray(original))
            return next.map((v, i) => {
                if (v && typeof v === "object" && !Array.isArray(v)) {
                    const row = v as Record<string, unknown>, key = typeof row.name === "string" ? "name" : typeof row.id === "string" ? "id" : undefined;
                    if (key) {
                        const matches = original.filter(p => p && typeof p === "object" && !Array.isArray(p) && (p as Record<string, unknown>)[key] === row[key]);
                        if (matches.length > 1)
                            throw new ManagementError("CONFIG_IDENTITY_AMBIGUOUS", 400);
                        return preserve(v, matches[0]);
                    }
                }
                return preserve(v, original[i]);
            });
        if (next && typeof next === "object" && !Array.isArray(next) && original && typeof original === "object" && !Array.isArray(original)) {
            const out = { ...next } as Record<string, unknown>, prior = original as Record<string, unknown>;
            for (const key of Object.keys(prior)) {
                if (isNapcatCredentialField(key)) {
                    out[key] = prior[key];
                    preservedCredentialFields++;
                }
                else if (key in out)
                    out[key] = hasNapcatProtectedMarker(out[key]) && typeof prior[key] === "string" ? prior[key] : preserve(out[key], prior[key]);
            }
            return out;
        }
        return next;
    };
    for (const [name, bytes] of requested) {
        const prior = existing.get(name);
        if (/^(?:key|cert)\.pem$/i.test(name)) {
            if (!prior)
                throw new ManagementError("SSL_REQUIRES_CERTIFICATE_OWNER", 400);
            requested.set(name, prior);
            preservedCredentialFields++;
            continue;
        }
        if (name.toLowerCase().endsWith(".json")) {
            let parsed: unknown;
            try {
                parsed = JSON.parse(bytes.toString("utf8"));
            }
            catch {
                throw new ManagementError("CONFIG_JSON_INVALID", 400);
            }
            if (prior) {
                let original: unknown;
                try {
                    original = JSON.parse(prior.toString("utf8"));
                }
                catch {
                    throw new ManagementError("NATIVE_CONFIG_JSON_INVALID");
                }
                requested.set(name, Buffer.from(JSON.stringify(preserve(parsed, original))));
            }
        }
    }
    return { bytes: writeNapcatConfigArchive(requested), preservedCredentialFields };
}
