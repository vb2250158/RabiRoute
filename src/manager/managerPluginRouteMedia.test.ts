import { interactiveOperation, LAN_AGENT_INTERACTIVE_ROUTES } from "../plugins/io.rabiroute.manager.core/src/manager/lanAgentInteractiveContract.js";
import { createLanAgentComputerOperations } from '../plugins/io.rabiroute.manager.core/src/manager/lanAgentComputerRoutes.js';
import { compileApiOperation } from './apiOperationContract.js';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { ApiOperationDefinition, ApiOperationResult } from './apiOperationContract.js';
import http from 'node:http';
import { once } from 'node:events';
import { ManagerPluginRouteRegistry } from './managerPluginRouteRegistry.js';
import { fixtureApiContract } from './apiOperationContractFixtures.js';
// @ts-expect-error Shared runtime JavaScript has no TypeScript declaration file.
import { projectManagerReceiptMedia } from '../../apps/rabi-agent/lib/operation-result.mjs';
// @ts-expect-error MCP runtime JavaScript has no TypeScript declaration file.
import { createKnowledgeMcpServer } from '../../apps/rabi-mcp/lib/knowledge-mcp-server.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDe8AAAAASUVORK5CYII=';
const image = { mimeType: 'image/png', data: png, width: 1, height: 1, frameId: 'http-frame', source: { displayId: 'display-two' } };
const declaration = [{ path: '/data', type: 'image', matchMimeType: 'image/*' }, { path: '/data/capture', type: 'image', matchMimeType: 'image/*' }];
async function serve(t: TestContext, body: unknown, { method = 'GET', status = 200, descriptor, headers = {}, stream }: {
    method?: string;
    status?: number;
    descriptor?: ApiOperationDefinition['contract']['responses'][string];
    headers?: Record<string, string>;
    stream?: ApiOperationResult['stream'];
} = {}) {
    const registry = new ManagerPluginRouteRegistry();
    const base = fixtureApiContract();
    const responseDescriptor = descriptor ?? { mediaType: 'application/json', schema: { type: 'object', 'x-rabiroute-media': declaration } };
    const registration = registry.registerOperations('media-fixture', [{ contract: { ...base, operationId: 'fixture.media', transport: stream ? 'sse' : 'http', method: method as 'GET' | 'HEAD', pathTemplate: '/api/media', request: { path: { type: 'object' }, query: { type: 'object' }, headers: { type: 'object' }, body: { kind: 'none' } }, responses: { [status]: responseDescriptor }, effects: { mode: 'read', description: 'Read fixture image.' } }, handler: () => ({ status, ...(body === undefined ? {} : { body }), ...(stream ? { stream } : {}), headers }) }]);
    const server = http.createServer((req, res) => { if (!registry.handle(req, new URL(req.url!, 'http://localhost'), res)) {
        res.statusCode = 404;
        res.end();
    } });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await registration.dispose(); });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/media`, { method });
    return { response, receipt: { ok: response.ok, statusCode: response.status, requestId: 'http-original', uncertain: false, headers: Object.fromEntries(response.headers), body: await response.text() } };
}
async function callMcp(t: TestContext, receipt: any) {
    const server = createKnowledgeMcpServer({ tools: { list: () => [{ name: 'media', inputSchema: { type: 'object' } }], call: async () => projectManagerReceiptMedia(receipt) } });
    const client = new Client({ name: 'http-media-integration', version: '1.0.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    t.after(async () => { await client.close(); await server.close(); });
    await server.connect(a);
    await client.connect(b);
    return await client.callTool({ name: 'media', arguments: {} }) as {
        content: Array<{
            type: string;
            data?: string;
        }>;
        structuredContent: Record<string, any>;
    };
}
test('registered response declaration travels over HTTP and reaches MCP as one image', async (t) => {
    const { response, receipt } = await serve(t, { code: 0, data: image }, { headers: { 'x-rabiroute-media': 'spoofed', 'etag': 'fixture-etag' } });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.headers.get('x-rabiroute-media')!), declaration);
    const result = await callMcp(t, receipt);
    assert.equal(result.content.filter((x: any) => x.type === 'image').length, 1);
    assert.equal(result.content.find((x: any) => x.type === 'image')!.data, png);
    assert.equal(result.structuredContent.requestId, 'http-original');
    assert.equal(result.structuredContent.headers.etag, 'fixture-etag');
    assert.ok(!JSON.stringify(result.structuredContent).includes(png));
    assert.equal(result.structuredContent.bodyJson.data.frameId, 'http-frame');
});
test('compound input capture projects nested image and retains operation return receipt', async (t) => {
    const { receipt } = await serve(t, { code: 0, data: { capture: image, returnResult: { cursor: 'restored', foreground: 'restored' } } });
    const result = await callMcp(t, receipt);
    assert.equal(result.content.filter((x: any) => x.type === 'image').length, 1);
    assert.equal(result.structuredContent.bodyJson.data.returnResult.cursor, 'restored');
});
test('conditional paths preserve ordinary file data on the same computer contract', async (t) => {
    const data = { mimeType: 'application/octet-stream', data: png, path: 'fixture.bin' };
    const { receipt } = await serve(t, { code: 0, data });
    const projected = projectManagerReceiptMedia(receipt);
    assert.equal(projected.media, undefined);
    assert.deepEqual(projected.bodyJson.data, data);
});
test('HEAD suppresses media declaration and payload', async (t) => {
    const { response, receipt } = await serve(t, { code: 0, data: image }, { method: 'HEAD', headers: { 'X-RabiRoute-Media': 'spoofed' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-rabiroute-media'), null);
    assert.equal(receipt.body, '');
});
test('no-body response suppresses reserved media header', async (t) => {
    const { response, receipt } = await serve(t, undefined, { status: 204, headers: { 'X-RabiRoute-Media': 'spoofed' } });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('x-rabiroute-media'), null);
    assert.equal(receipt.body, '');
});
test('handler media header cannot manufacture declarations without registered schema', async (t) => {
    const data = { mimeType: 'image/png', data: png };
    const { response, receipt } = await serve(t, { code: 0, data }, { descriptor: { mediaType: 'application/json', schema: { type: 'object' } }, headers: { 'x-rabiroute-media': JSON.stringify(declaration) } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-rabiroute-media'), null);
    assert.equal(projectManagerReceiptMedia(receipt).media, undefined);
});
test('stream retains its framing and omits image response declarations', async (t) => {
    const descriptor: ApiOperationDefinition['contract']['responses'][string] = { mediaType: 'text/event-stream', stream: { framing: 'sse-json', maxFrameBytes: 1024, frameSchema: { type: 'object', properties: { data: { type: 'object' } } }, completion: 'Finite fixture EOF.', cancellation: 'Stop fixture iterator.' } };
    const stream = { frames: (async function* () { yield { data: { ready: true } }; })(), cancel: async () => { } };
    const { response, receipt } = await serve(t, undefined, { descriptor, stream, headers: { 'x-rabiroute-media': JSON.stringify(declaration) } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-rabiroute-media'), null);
    assert.equal(receipt.body, 'data: {"ready":true}\n\n');
});
test('actual computer operation registers its single and compound response paths', () => {
    const [operation] = createLanAgentComputerOperations({ registry: {}, isManagementRequestAuthorized: () => true } as any);
    assert.deepEqual((operation!.contract.responses['200']!.schema as Record<string, unknown>)['x-rabiroute-media'], declaration);
    assert.doesNotThrow(() => compileApiOperation(operation!));
});


test("unsupported coordinate dispatch preserves original receipt uncertainty semantics", async () => {
    const route = LAN_AGENT_INTERACTIVE_ROUTES.find(item => item.key === "computer.execute")!;
    const operation = interactiveOperation(route, { isManagementRequestAuthorized: () => true } as any, async () => {
        throw Object.assign(new Error("Scaled coordinates require imageView-v1."), {
            code: "COMPUTER_IMAGE_VIEW_UNSUPPORTED", field: "source.imageView", deliveryFrameSent: false,
            requestId: "original-input", nextAction: "Query input.status with original-input before inspecting earlier input."
        });
    });
    const result = await operation.handler({ request: { headers: {} }, url: new URL("http://fixture.invalid"),
        path: { instanceId: "node" }, body: { action: "input.execute", requestId: "original-input" } } as any);
    assert.equal(result.status, 400);
    const body = result.body as Record<string, unknown>;
    assert.equal(body.errorCode, "COMPUTER_IMAGE_VIEW_UNSUPPORTED");
    assert.equal(body.field, "source.imageView");
    assert.equal(body.mutationOutcome, undefined);
    assert.equal(body.uncertain, undefined);
    assert.match(String(body.repair), /input.status.*original-input/);
});
