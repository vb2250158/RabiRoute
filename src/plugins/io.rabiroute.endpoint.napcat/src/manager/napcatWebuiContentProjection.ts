import { readNapcatConfigArchive, writeNapcatConfigArchive } from "./napcatWebuiConfigArchive.js";
import { qqReadSettings } from "@rabiroute/host-api/shared/qqReadSettings";
import { ManagementError } from "./napcatWebuiManagementOperations.js";
import { isNapcatCredentialField as protectedField } from "./napcatWebuiSecrets.js";
type Row = Record<string, unknown>;
export type NapcatContentProjection = {
    bytes: Buffer;
    redacted: boolean;
    redactions: number;
};
const pem = /-----BEGIN (?:[A-Z0-9 ]*PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [A-Z0-9 ]+-----/g;
/** Content-semantic projection, not a filename allowlist. Non-sensitive source bytes remain byte-for-byte identical. */
export async function projectNapcatWebuiContent(input: Uint8Array, source?: {
    filename?: string;
}): Promise<NapcatContentProjection> {
    let expanded = 0;
    const project = async (bytes: Buffer, filename?: string): Promise<NapcatContentProjection> => {
        expanded += bytes.length;
        if (expanded > qqReadSettings.mediaBytes)
            throw new ManagementError("CONTENT_INSPECTION_BUDGET", 413);
        // These are the pinned native SSL owner's exact credential files, including malformed/opaque key bytes.
        // Content inspection below additionally catches real PEM and credential structures under unrelated names.
        if (["key.pem", "cert.pem"].includes(String(filename ?? "").replace(/\\/g, "/").split("/").at(-1)!.toLowerCase()))
            return {
                bytes: Buffer.from('{"protectedContent":true,"kind":"native-ssl-material"}'), redacted: true, redactions: 1
            };
        const isZip = bytes.length >= 4 && (bytes.readUInt32LE(0) === 0x04034b50 || bytes.readUInt32LE(0) === 0x06054b50);
        if (isZip) {
            let entries: Map<string, Buffer>;
            try {
                entries = await readNapcatConfigArchive(bytes, { flat: false });
            }
            catch (error) {
                throw new ManagementError("ARCHIVE_CONTENT_INSPECTION_UNAVAILABLE", 409);
            }
            let redactions = 0;
            const projected = new Map<string, Buffer>();
            for (const [name, entry] of entries) {
                const item = await project(entry, name);
                redactions += item.redactions;
                projected.set(name, item.bytes);
            }
            return redactions ? {
                bytes: writeNapcatConfigArchive(projected), redacted: true, redactions
            } : {
                bytes, redacted: false, redactions: 0
            };
        }
        let text: string;
        try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        }
        catch {
            // Never decode/re-encode ordinary images or other opaque binary formats.
            // A literal PEM block in a binary wrapper remains credential material, not a normal binary artifact.
            if (/-----BEGIN (?:[A-Z0-9 ]*PRIVATE KEY|CERTIFICATE)-----/.test(bytes.toString("latin1")))
                return {
                    bytes: Buffer.from('{"protectedContent":true,"kind":"PEM"}'), redacted: true, redactions: 1
                };
            return {
                bytes, redacted: false, redactions: 0
            };
        }
        let redactions = 0;
        const secretFields = new Set<string>();
        const discover = (value: unknown): void => {
            if (Array.isArray(value)) {
                for (const item of value)
                    discover(item);
                return;
            }
            if (!value || typeof value !== "object")
                return;
            const row = value as Row;
            if (row.type === "password" || row.inputType === "password" || row.sensitive === true || row.secret === true || (row.props && typeof row.props === "object" && (row.props as Row).type === "password")) {
                for (const key of [
                    "key", "name", "field"
                ])
                    if (typeof row[key] === "string")
                        secretFields.add(row[key] as string);
            }
            for (const child of Object.values(row))
                discover(child);
        };
        const clean = (value: unknown, sensitiveSchema = false): unknown => {
            if (typeof value === "string") {
                const text = value.replace(pem, () => {
                    redactions++;
                    return "[protected PEM]";
                });
                try {
                    const url = new URL(text);
                    if ([
                        "http:", "https:", "ws:", "wss:"
                    ].includes(url.protocol)) {
                        let changed = false;
                        if (url.username) {
                            url.username = "[protected]";
                            changed = true;
                        }
                        if (url.password) {
                            url.password = "[protected]";
                            changed = true;
                        }
                        for (const key of [...url.searchParams.keys()])
                            if (protectedField(key)) {
                                url.searchParams.set(key, "[protected]");
                                changed = true;
                            }
                        const fragment = new URLSearchParams(url.hash.slice(1));
                        let hiddenFragment = false;
                        for (const key of [...fragment.keys()])
                            if (protectedField(key)) {
                                fragment.set(key, "[protected]");
                                hiddenFragment = true;
                            }
                        if (hiddenFragment) {
                            url.hash = fragment.toString();
                            changed = true;
                        }
                        if (changed) {
                            redactions++;
                            return url.href;
                        }
                    }
                }
                catch { /* A normal text value is not required to be a URL. */
                }
                return text;
            }
            if (Array.isArray(value))
                return value.map(item => clean(item));
            if (!value || typeof value !== "object")
                return value;
            const row = value as Row, result: Row = {};
            const passwordControl = row.type === "password" || row.inputType === "password" || row.sensitive === true || row.secret === true || (row.props && typeof row.props === "object" && (row.props as Row).type === "password");
            for (const [key, child] of Object.entries(row)) {
                const schemaChild = Boolean(child && typeof child === "object" && !Array.isArray(child) && [
                    "string", "object", "array", "boolean", "integer", "number", "null"
                ].includes(String((child as Row).type)));
                if ((protectedField(key) || secretFields.has(key)) && schemaChild) {
                    const allowed = new Set([
                        "type", "description", "title", "format", "writeOnly", "readOnly", "minLength", "maxLength", "minimum", "maximum", "pattern", "properties", "items", "required", "additionalProperties", "enum", "default", "defaultValue", "value", "examples", "example"
                    ]);
                    const schema = Object.fromEntries(Object.entries(child as Row).filter(([field]) => {
                        if (allowed.has(field))
                            return true;
                        redactions++;
                        return false;
                    }));
                    Object.defineProperty(result, key, {
                        value: clean(schema, true), enumerable: true, writable: true, configurable: true
                    });
                    continue;
                }
                if ((protectedField(key) || secretFields.has(key) || (passwordControl || sensitiveSchema) && [
                    "value", "default", "defaultValue", "examples", "example", "enum"
                ].includes(key)) && child !== null && child !== undefined && child !== "") {
                    redactions++;
                    Object.defineProperty(result, key, {
                        value: "[protected]", enumerable: true, writable: true, configurable: true
                    });
                }
                else
                    Object.defineProperty(result, key, {
                        value: clean(child), enumerable: true, writable: true, configurable: true
                    });
            }
            return result;
        };
        try {
            const value = JSON.parse(text);
            discover(value);
            const result = clean(value);
            if (redactions)
                return {
                    bytes: Buffer.from(JSON.stringify(result)), redacted: true, redactions
                };
        }
        catch { /* Ordinary non-JSON text retains its exact bytes unless it contains known credential material. */
        }
        const projected = text.replace(pem, () => {
            redactions++;
            return "[protected PEM]";
        }).replace(/https?:\/\/[^\s"'<>]+/g, value => String(clean(value))).replace(/^(\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]\s*)([^\r\n]*)/gm, (whole, prefix, key, value) => {
            if (!protectedField(key) || !String(value).trim())
                return whole;
            redactions++;
            return prefix + "[protected]";
        });
        return redactions ? {
            bytes: Buffer.from(projected), redacted: true, redactions
        } : {
            bytes, redacted: false, redactions: 0
        };
    };
    return project(Buffer.from(input), source?.filename);
}
