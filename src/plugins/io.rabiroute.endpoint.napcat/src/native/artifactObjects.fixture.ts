import { createHash, randomUUID } from "node:crypto";
import { createProtectedResourceObjects } from "../../../../manager/protectedResourceObjects.js";
import type { NativeResourceObject, NativeResourceObjects } from "./artifactObjects.js";
/** An injected object-store fixture. Production always receives the original shared ResourceCache instance. */
export function memoryResourceObjects(maxObjectBytes = 4096) {
    const values = new Map<string, Buffer>();
    const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
    const resources: NativeResourceObjects = {
        maxObjectBytes,
        async put(owner, id, body, authorize) {
            authorize();
            if (body.length > resources.maxObjectBytes || digest(body) !== id)
                throw new Error("Fixture resource integrity failure");
            values.set(`${owner}/${id}`, Buffer.from(body));
            return { id, bytes: body.length, sha256: id };
        },
        async read(owner, id) {
            const body = values.get(`${owner}/${id}`);
            if (!body)
                throw Object.assign(new Error("Fixture object absent"), { code: "ENOENT" });
            if (digest(body) !== id)
                throw new Error("Fixture object integrity failure");
            return Buffer.from(body);
        },
        async findByOwner(owner) {
            const found: NativeResourceObject[] = [];
            for (const key of values.keys())
                if (key.startsWith(owner + "/")) {
                    const id = key.slice(owner.length + 1), bytes = await resources.read(owner, id);
                    found.push({ id, bytes: bytes.length, sha256: id });
                }
            return found;
        }
    };
    const issued = new Map<string, string>();
    const protectedResources = createProtectedResourceObjects({
        put: async (owner, id, body, authorize = () => {
        }) => ({ ...await resources.put(owner, id, Buffer.from(body), authorize), durable: true }),
        read: async (owner, id) => Buffer.from(await resources.read(owner, id)), findByOwner: resources.findByOwner
    }, {
        scheme: "fixture-original-secret-owner",
        async protect(plaintext) {
            const token = randomUUID();
            issued.set(token, plaintext);
            return token;
        },
        async unprotect(token) {
            const plaintext = issued.get(token);
            if (plaintext === undefined)
                throw Error("Unissued fixture secret-owner token");
            return plaintext;
        }
    }, "message-endpoint-private-metadata@1");
    return { resources, protectedResources, values };
}
