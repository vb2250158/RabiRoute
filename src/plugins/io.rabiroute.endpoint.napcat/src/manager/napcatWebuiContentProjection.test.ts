import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { projectNapcatWebuiContent } from "./napcatWebuiContentProjection.js";
import { writeNapcatConfigArchive, readNapcatConfigArchive } from "./napcatWebuiConfigArchive.js";
// Deliberately invalid key material; the recognizer still receives the exact runtime PEM envelope.
const fixturePemLabel = ["PRIVATE", "KEY"].join(" ");
const fixturePem = [`-----BEGIN ${fixturePemLabel}-----`, "SYNTHETIC_PRIVATE_KEY", `-----END ${fixturePemLabel}-----`, ""].join("\n");
test("ordinary non-sensitive files and archives preserve their actual original bytes and hashes", async () => {
    const files = [
        Buffer.from("ordinary user notes\r\n"), Buffer.from('{ "count": 3, "items": ["a","b"] }\n'), Buffer.from([
            0x89, 0x50, 0x4e, 0x47, 0, 0xff, 0xaa
        ]), writeNapcatConfigArchive(new Map([["docs/ordinary.txt", Buffer.from("ordinary unchanged")]]))
    ];
    for (const original of files) {
        const result = await projectNapcatWebuiContent(original);
        assert.equal(result.redacted, false);
        assert(result.bytes.equals(original));
        assert.equal(createHash("sha256").update(result.bytes).digest("hex"), createHash("sha256").update(original).digest("hex"));
    }
});
test("credential content and private PEM are projected even when supplied under unrelated names", async () => {
    const original = Buffer.from(fixturePem);
    const pem = await projectNapcatWebuiContent(original, { filename: "ordinary.txt" });
    assert(pem.redacted);
    assert(!pem.bytes.includes("SYNTHETIC_PRIVATE_KEY"));
    const data = await projectNapcatWebuiContent(Buffer.from(JSON.stringify({
        token: "SYNTHETIC_TOKEN", network: { httpServers: [{ token: "SYNTHETIC_ONEBOT" }] }, url: "https://name:URL_PASSWORD@example.test/path?access_token=URL_TOKEN", schema: [{
                key: "opaqueSetting", type: "password", default: "PRIVATE_DEFAULT"
            }], config: { opaqueSetting: "PRIVATE_CONFIG" }
    })));
    assert(data.redacted);
    for (const secret of [
        "SYNTHETIC_TOKEN", "SYNTHETIC_ONEBOT", "URL_PASSWORD", "URL_TOKEN", "PRIVATE_DEFAULT", "PRIVATE_CONFIG"
    ])
        assert(!data.bytes.includes(secret), secret);
    const env = await projectNapcatWebuiContent(Buffer.from("NAPCAT_WEBUI_JWT_SECRET_KEY=SYNTHETIC_JWT\nordinary=kept\n"));
    assert(env.redacted);
    assert(!env.bytes.includes("SYNTHETIC_JWT"));
    assert(env.bytes.includes("ordinary=kept"));
});
test("configuration ZIP projection reports its new exact bytes/hash and keeps ordinary nested entries", async () => {
    const original = writeNapcatConfigArchive(new Map([
        ["webui.json", Buffer.from('{"token":"SYNTHETIC_TOKEN","port":6099}')], ["key.pem", Buffer.from("SYNTHETIC_PRIVATE_KEY")], ["notes/ordinary.txt", Buffer.from("byte exact user content")]
    ]));
    const result = await projectNapcatWebuiContent(original);
    assert(result.redacted);
    assert(!result.bytes.equals(original));
    const archive = await readNapcatConfigArchive(result.bytes, { flat: false });
    assert.equal(archive.get("notes/ordinary.txt")!.toString(), "byte exact user content");
    assert(!archive.get("webui.json")!.includes("SYNTHETIC_TOKEN"));
    assert(!archive.get("key.pem")!.includes("SYNTHETIC_PRIVATE_KEY"));
});
