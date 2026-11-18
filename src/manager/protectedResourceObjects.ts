import { createHash } from "node:crypto";
import type { AsyncLocalSecretProtector } from "../shared/localSecretProtection.js";
import type { ResourceCache } from "./resourceCache.js";

const format = "rabiroute-protected-resource-v1";
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const keys = (value: unknown, expected: string[]) => value !== null && typeof value === "object"
  && !Array.isArray(value) && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
const canonicalBase64 = (value: unknown): value is string => typeof value === "string"
  && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  && Buffer.from(value, "base64").toString("base64") === value;

/** Encryption protects private metadata; original business owners still own delivery receipts. */
export function createProtectedResourceObjects(cache: Pick<ResourceCache, "put" | "read" | "findByOwner">, protector: AsyncLocalSecretProtector, purpose: string) {
  if (!purpose) throw new Error("Protected resource purpose is required.");
  const check = (authorize: () => void, signal?: AbortSignal) => { signal?.throwIfAborted(); authorize(); };
  return Object.freeze({
    async putProtected(owner: string, plaintext: Buffer, authorize: () => void = () => {}, signal?: AbortSignal) {
      check(authorize, signal);
      if (!owner || !Buffer.isBuffer(plaintext)) throw new Error("Invalid protected resource input.");
      const inner = JSON.stringify({ format, owner, purpose, data: plaintext.toString("base64") });
      const ciphertext = await protector.protect(inner, signal);
      check(authorize, signal);
      const bytes = Buffer.from(JSON.stringify({ format, scheme: protector.scheme, owner, purpose, ciphertext }));
      const result = await cache.put(owner, digest(bytes), bytes, () => check(authorize, signal));
      check(authorize, signal);
      return result;
    },
    async readProtected(owner: string, id: string, authorize: () => void = () => {}, signal?: AbortSignal) {
      check(authorize, signal);
      const bytes = await cache.read(owner, id);
      check(authorize, signal);
      let envelope: any;
      try { envelope = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Invalid protected resource envelope."); }
      if (!keys(envelope, ["format", "scheme", "owner", "purpose", "ciphertext"]) || envelope.format !== format
        || envelope.scheme !== protector.scheme || envelope.owner !== owner || envelope.purpose !== purpose
        || typeof envelope.ciphertext !== "string" || !envelope.ciphertext) throw new Error("Invalid protected resource envelope.");
      const decoded = await protector.unprotect(envelope.ciphertext, signal);
      check(authorize, signal);
      let inner: any;
      try { inner = JSON.parse(decoded); } catch { throw new Error("Invalid protected resource contents."); }
      if (!keys(inner, ["format", "owner", "purpose", "data"]) || inner.format !== format || inner.owner !== owner
        || inner.purpose !== purpose || !canonicalBase64(inner.data)) throw new Error("Invalid protected resource contents.");
      return Buffer.from(inner.data, "base64");
    },
    async findByOwner(owner: string, authorize: () => void = () => {}, signal?: AbortSignal) {
      check(authorize, signal);
      const result = await cache.findByOwner(owner);
      check(authorize, signal);
      return result;
    }
  });
}
