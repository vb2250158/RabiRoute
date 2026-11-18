import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import type { ApiOperationInput } from "@rabiroute/host-api/manager/apiOperationContract";
import type { GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import { createNapcatArtifactOperations, type NapcatArtifactContext } from "./artifactOperations.js";
import { memoryResourceObjects } from "./artifactObjects.fixture.js";

/** Fixed dummy value for injected offline test transports; never a real account credential. */
const fixtureAccessToken = "fixture-token";

const route = { id: "route", enabled: true, messageAdapters: ["napcat"], napcatInstances: [
        { id: "instance", enabled: true, httpUrl: "http://127.0.0.1:12345", botUserId: "12345", accessToken: fixtureAccessToken }
    ] } as GatewayDefinition;
function input(params?: unknown, action?: string): ApiOperationInput {
    return { request: { headers: {} } as IncomingMessage, response: {}, url: new URL("http://fixture.invalid"), path: {}, query: {},
        body: { routeId: "route", instanceId: "instance", deliveryId: "original-generation", ...(params ? { params } : { action }) } } as ApiOperationInput;
}
async function fixture(t: test.TestContext) {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "napcat-native-artifact-"));
    t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
    const store = memoryResourceObjects(), body = Buffer.alloc(3000, 7), calls: string[] = [];
    const context: NapcatArtifactContext = { rootDir, resourceObjects: store.resources, protectedResourceObjects: store.protectedResources, route: () => route, local: () => true, readOnly: () => false,
        transport: async (url) => {
            const target = new URL(String(url));
            calls.push(target.pathname);
            if (target.hostname === "fixture-cdn.invalid")
                return new Response(body);
            const data = target.pathname === "/get_login_info" ? { user_id: "12345" }
                : target.pathname === "/get_flash_file_url" ? { result: 0, transferUrl: "https://fixture-cdn.invalid/file?signature=private-value" }
                    : "https://fixture-cdn.invalid/audio?signature=private-value";
            return Response.json({ status: "ok", retcode: 0, data });
        } };
    return { rootDir, store, body, calls, context };
}
for (const action of ["get_ai_record", "get_flash_file_url"] as const) {
    test(`${action} completes bytes before its original receipt and reclaims the same result without another native request`, async (t) => {
        const f = await fixture(t), operations = createNapcatArtifactOperations(f.context);
        const operation = operations.find(value => value.contract.operationId === `agent.qq.onebot.${action}`)!;
        const request = input(action === "get_ai_record" ? { group_id: "789", character: "voice", text: "fixture text" } : { fileset_id: "original-set", file_index: 0 });
        const first = await operation.handler(request), repeated = await operation.handler(request);
        assert.equal(first.status, 200, JSON.stringify(first.body));
        assert.equal(repeated.status, 200);
        assert.deepEqual((first.body as {
            data: unknown;
        }).data, (repeated.body as {
            data: unknown;
        }).data);
        assert.equal(f.calls.filter(name => name === "/" + action).length, 1);
        const read = operations.find(value => value.contract.operationId === "agent.qq.native-artifact.read")!;
        const output = await read.handler(input(undefined, action));
        assert.equal(output.status, 200, JSON.stringify(output.body));
        assert.ok(output.stream?.frames);
        const chunks: Buffer[] = [];
        for await (const chunk of output.stream.frames)
            chunks.push(Buffer.from(chunk as Uint8Array));
        assert.deepEqual(Buffer.concat(chunks), f.body);
        assert.doesNotMatch(JSON.stringify(first.body), /private-value|fixture-cdn|signature/);
        const files = await fs.readdir(f.rootDir, { recursive: true });
        for (const file of files.filter(name => name.endsWith(".json"))) {
            assert.doesNotMatch(await fs.readFile(path.join(f.rootDir, file), "utf8"), /private-value|fixture-cdn/);
        }
    });
}
test("a lost native generation response remains unknown through the original delivery and is never regenerated", async (t) => {
    const f = await fixture(t), original = f.context.transport!;
    f.context.transport = async (...args) => {
        if (new URL(String(args[0])).pathname === "/get_ai_record") {
            f.calls.push("/get_ai_record");
            throw new Error("Fixture native response lost");
        }
        return original(...args);
    };
    const request = input({ group_id: "789", character: "voice", text: "fixture text" });
    for (let attempt = 0; attempt < 2; attempt++) {
        const operation = createNapcatArtifactOperations(f.context)[0]!;
        const result = await operation.handler(request);
        assert.equal(result.status, 202, JSON.stringify(result.body));
    }
    assert.equal(f.calls.filter(name => name === "/get_ai_record").length, 1);
    assert.equal(f.store.values.size, 0);
});
test("a complete artifact recovers a lost receipt acknowledgement in a fresh native operation owner", async (t) => {
    const f = await fixture(t), originalPut = f.store.protectedResources.putProtected, originalFind = f.store.protectedResources.findByOwner;
    let published = false, unavailable = true;
    f.context.protectedResourceObjects = { ...f.store.protectedResources,
        async putProtected(...args) {
            const result = await originalPut(...args);
            published = true;
            throw new Error("Fixture receipt acknowledgement lost");
        },
        async findByOwner(owner) {
            if (published && unavailable)
                throw new Error("Fixture original artifact temporarily unavailable");
            return originalFind(owner);
        }
    };
    const request = input({ group_id: "789", character: "voice", text: "fixture text" });
    assert.equal((await createNapcatArtifactOperations(f.context)[0]!.handler(request)).status, 202);
    unavailable = false;
    f.context.protectedResourceObjects = f.store.protectedResources;
    const recovered = await createNapcatArtifactOperations(f.context)[0]!.handler(request);
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    assert.equal(f.calls.filter(name => name === "/get_ai_record").length, 1);
});
test("read-only, caller URLs and partial206 resources never become a completed native artifact", async (t) => {
    const f = await fixture(t), request = input({ group_id: "789", character: "voice", text: "fixture text" });
    f.context.readOnly = () => true;
    assert.equal((await createNapcatArtifactOperations(f.context)[0]!.handler(request)).status, 403);
    assert.equal(f.calls.length, 0);
    f.context.readOnly = () => false;
    assert.equal((await createNapcatArtifactOperations(f.context)[0]!.handler(input({ url: "https://caller.invalid" }))).status, 400);
    const original = f.context.transport!;
    f.context.transport = async (...args) => new URL(String(args[0])).hostname === "fixture-cdn.invalid" ? new Response(f.body, { status: 206 }) : original(...args);
    assert.equal((await createNapcatArtifactOperations(f.context)[0]!.handler(request)).status, 202);
    assert.equal(f.store.values.size, 0);
});
