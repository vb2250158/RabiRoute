import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiContractError, apiContractFailure, apiDigest, compileApiOperation, prepareApiOperation, compiledApiPathsEquivalent, compiledApiTailPathsOverlap, readApiOperationInput, validateApiOperationResult,
  type ApiOperationContract, type ApiOperationDefinition } from "./apiOperationContract.js";
import { apiCatalogOpenApi } from "./apiOperationCatalog.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";

import { fixtureApiContract } from "./apiOperationContractFixtures.js";
import { apiPathTemplatesEquivalent, apiTailPathsOverlap } from "../../apps/rabi-agent/lib/api-path-template.mjs";

function input(body: string, contentType = "application/json") {
  const request = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
  request.headers = { "content-type": contentType };
  return request;
}

test("operation preparation captures one immutable contract and its original callbacks", () => {
  const originalHandler = () => ({ status: 200, body: { original: true } });
  const originalPrepare = () => originalHandler;
  const mutable = { contract: fixtureApiContract(), handler: originalHandler, prepare: originalPrepare };
  const compile = prepareApiOperation(mutable);
  mutable.contract = { ...mutable.contract, description: "Changed after preparation." };
  mutable.handler = () => ({ status: 200, body: { original: false } });
  mutable.prepare = () => mutable.handler;
  const operation = compile();
  assert.equal(operation.handler, originalHandler);
  assert.equal(operation.prepare, originalPrepare);
  assert.equal(operation.contract.description, "Write one example record.");
  assert.ok(Object.isFrozen(operation.contract.request.body));
});

test("compiled route comparisons preserve public helper semantics for every path binding pair", () => {
  const shapes: Array<{ template: string; tails?: string[]; remainder?: string; literals?: string[] }> = [
    { template: "/alpha/:id" }, { template: "/alpha/:other" }, { template: "/Alpha/:id" },
    { template: "/Alpha/:id", literals: ["Alpha"] }, { template: "/beta/:id" },
    { template: "/alpha/:tail", tails: ["tail"] }, { template: "/alpha/:rest", remainder: "rest" },
    { template: "/alpha/:rest" }, { template: "/alpha/raw:rest", remainder: "rest" },
    { template: "/alpha/raw:other", remainder: "other" }, { template: "/alpha/rawdata" },
    { template: "/alpha/RawData", literals: ["RawData"] }, { template: "/alpha/rawdeep/more" },
    { template: "/alpha" }, { template: "/:path", remainder: "path" },
    { template: "/assets/:tail", tails: ["tail"], literals: ["assets"] },
  ];
  const compiled = shapes.map((shape, index) => {
    const base = fixtureApiContract();
    return compileApiOperation({ contract: { ...base, operationId: `fixture.comparison.${index}`, pathTemplate: shape.template,
      request: { ...base.request, ...(shape.tails ? { pathTails: shape.tails } : {}), ...(shape.remainder ? { pathRemainder: shape.remainder } : {}),
        ...(shape.literals ? { pathCaseInsensitiveLiterals: shape.literals } : {}) } },
      handler: () => ({ status: 200, body: {} }) });
  });
  for (const operation of compiled) {
    for (const segments of [operation.pathSegments, operation.pathEquivalenceSegments]) {
      assert.ok(Object.isFrozen(segments));
      assert.ok(segments.every(Object.isFrozen));
    }
  }
  assert.equal(compiled[8]!.pathSegments[2]!.name, "rest");
  assert.equal(compiled[8]!.pathEquivalenceSegments[2]!.literal, "raw:rest");
  for (let left = 0; left < shapes.length; left++) for (let right = 0; right < shapes.length; right++) {
    const a = shapes[left]!, b = shapes[right]!, message = `${left}:${right}`;
    assert.equal(compiledApiPathsEquivalent(compiled[left]!, compiled[right]!),
      apiPathTemplatesEquivalent(a.template, b.template, a.literals, b.literals), `equivalence ${message}`);
    assert.equal(compiledApiTailPathsOverlap(compiled[left]!, compiled[right]!),
      apiTailPathsOverlap(a.template, b.template, a.tails, b.tails, a.remainder, b.remainder, a.literals, b.literals), `overlap ${message}`);
  }
  for (const [left, right] of [[0, 1], [0, 2], [0, 3], [5, 13], [8, 9], [8, 11], [8, 12], [14, 4]] as const) {
    const registry = new ManagerPluginRouteRegistry();
    registry.registerOperations("left", [compiled[left]!]);
    const register = () => registry.registerOperations("right", [compiled[right]!]);
    const a = shapes[left]!, b = shapes[right]!;
    const overlap = apiPathTemplatesEquivalent(a.template, b.template, a.literals, b.literals)
      || apiTailPathsOverlap(a.template, b.template, a.tails, b.tails, a.remainder, b.remainder, a.literals, b.literals);
    if (overlap) assert.throws(register, /routes overlap/);
    else assert.doesNotThrow(register);
  }
});

test("equivalent cloned schemas reuse validators without changing request or response validation", async () => {
  const definition = { contract: fixtureApiContract(), handler: () => ({ status: 200, body: { ok: true, value: 1 } }) };
  const first = compileApiOperation(definition);
  const second = compileApiOperation({ ...definition, contract: JSON.parse(JSON.stringify(definition.contract)) });
  assert.notEqual(first.contract, second.contract);
  assert.equal(first.bodyValidator, second.bodyValidator);
  assert.equal(first.pathValidator, second.pathValidator);
  assert.equal(first.responseValidators.get("200")![0]!.body, second.responseValidators.get("200")![0]!.body);
  assert.equal(first.digest, second.digest);
  const url = new URL("http://fixture/api/example/records/one");
  for (const operation of [first, second]) {
    assert.deepEqual((await readApiOperationInput(operation, input('{"value":2}'), url, {} as ServerResponse)).body, { value: 2 });
    await assert.rejects(readApiOperationInput(operation, input('{"value":-1}'), url, {} as ServerResponse), { code: "API_REQUEST_SCHEMA_INVALID" });
    assert.throws(() => validateApiOperationResult(operation, { status: 200, body: { ok: true } }), { code: "API_RESPONSE_SCHEMA_INVALID" });
  }
});

test("local references retain their full schema scope and distinct schemas never share validators", () => {
  const compile = (minimum: number) => {
    const base = fixtureApiContract();
    return compileApiOperation({ contract: { ...base, request: { ...base.request, body: { kind: "json", maxBytes: 1024,
      schema: { type: "object", required: ["value"], properties: { value: { $ref: "#/$defs/value" } },
        $defs: { value: { type: "integer", minimum } } } } } }, handler: () => ({ status: 200, body: {} }) });
  };
  const first = compile(1), equivalent = compile(1), second = compile(20);
  assert.equal(first.bodyValidator, equivalent.bodyValidator);
  assert.notEqual(first.bodyValidator, second.bodyValidator);
  assert.equal(first.bodyValidator!({ value: 5 }), true);
  assert.equal(second.bodyValidator!({ value: 5 }), false);
  assert.equal(second.bodyValidator!({ value: 25 }), true);
});

test("schemas with IDs and external references preserve Ajv registry and duplicate-ID semantics", () => {
  const id = "urn:rabi:fixture:api-schema-cache-registry";
  const base = fixtureApiContract();
  const definition = (schema: Readonly<Record<string, unknown>>): ApiOperationDefinition => ({
    contract: { ...base, request: { ...base.request, query: schema } }, handler: () => ({ status: 200, body: {} })
  });
  const registered = { $id: id, type: "object", required: ["amount"], properties: { amount: { type: "integer" } } };
  compileApiOperation(definition(registered));
  assert.throws(() => compileApiOperation(definition(registered)), /already exists/, "A matching JSON cache key must not bypass duplicate-ID checks.");
  const first = compileApiOperation(definition({ $ref: id })), second = compileApiOperation(definition({ $ref: id }));
  assert.notEqual(first.queryValidator, second.queryValidator, "External resolution does not use the JSON-only cache.");
  assert.equal(first.queryValidator({ amount: 2 }), true);
  assert.equal(second.queryValidator({ amount: "wrong" }), false);
  assert.throws(() => compileApiOperation(definition({ $id: id, type: "object", properties: { amount: { type: "string" } } })), /already exists/);
});

test("schema cache eviction keeps existing validators usable and oversized schemas are not retained", () => {
  const base = fixtureApiContract();
  const compile = (schema: Readonly<Record<string, unknown>>) => compileApiOperation({ contract: { ...base,
    request: { ...base.request, body: { kind: "json", maxBytes: 1024, schema } } }, handler: () => ({ status: 200, body: {} }) });
  const schema = { type: "integer", const: 0, description: "eviction fixture" };
  const first = compile(schema);
  for (let index = 1; index <= 260; index++) compile({ ...schema, const: index });
  assert.notEqual(first.bodyValidator, compile(schema).bodyValidator);
  assert.equal(first.bodyValidator!(0), true);
  assert.equal(first.bodyValidator!(1), false);
  const oversized = { type: "integer", description: "x".repeat(512 * 1024) };
  assert.notEqual(compile(oversized).bodyValidator, compile(oversized).bodyValidator);
});

test("a no-body contract accepts zero-byte chunked transport framing but rejects actual payload bytes", async () => {
  const source = fixtureApiContract();
  const operation = compileApiOperation({ contract: { ...source, request: { ...source.request, body: { kind: "none" } } }, handler: () => ({ status: 200, body: { ok: true, value: 1 } }) });
  const empty = input(""); empty.headers["transfer-encoding"] = "chunked";
  await readApiOperationInput(operation, empty, new URL("http://fixture/api/example/records/one"), {} as ServerResponse);
  const nonempty = input("payload"); nonempty.headers["transfer-encoding"] = "chunked";
  await assert.rejects(readApiOperationInput(operation, nonempty, new URL("http://fixture/api/example/records/one"), {} as ServerResponse), { code: "API_BODY_UNEXPECTED" });
});

test("JSON can explicitly retain a native zero application byte limit without weakening other body limits", async () => {
  const base = fixtureApiContract();
  const contract: ApiOperationContract = { ...base, request: { ...base.request, body: { kind: "json", schema: { type: "object" }, maxBytes: 0 } } };
  const definition = { contract, handler: () => ({ status: 200, body: { ok: true, value: 1 } }) };
  const operation = compileApiOperation(definition), raw = { extension: "x".repeat(100000) };
  assert.deepEqual((await readApiOperationInput(operation, input(JSON.stringify(raw)), new URL("http://fixture/api/example/records/one"), {} as ServerResponse)).body, raw);
  assert.throws(() => compileApiOperation({ ...definition, contract: { ...contract, request: { ...contract.request, body: { kind: "json", schema: true, maxBytes: -1 } } } }), /body limit/);
  assert.throws(() => compileApiOperation({ ...definition, contract: { ...contract, request: { ...contract.request, body: { kind: "text", mediaType: "text/plain", schema: true, maxBytes: 0 } } } }), /body limit/);
});

test("explicit empty JSON decoding is schema-checked, request-local and projected into OpenAPI", async () => {
  const base = fixtureApiContract();
  const contract: ApiOperationContract = { ...base, request: { ...base.request,
    body: { kind: "json", schema: { type: "object", required: ["value"], properties: { value: { type: "integer" } } },
      maxBytes: 1024, emptyValue: { value: 3 }, allowAnyContentType: true } } };
  const definition = { contract, handler: () => ({ status: 200, body: { ok: true, value: 3 } }) };
  const compiled = compileApiOperation(definition);
  const url = new URL("http://localhost/api/example/records/one"); const response = {} as ServerResponse;
  const first = await readApiOperationInput(compiled, input("", ""), url, response);
  (first.body as { value: number }).value = 9;
  assert.deepEqual((await readApiOperationInput(compiled, input(""), url, response)).body, { value: 3 });
  await assert.rejects(readApiOperationInput(compiled, input(" "), url, response), { code: "API_JSON_INVALID" });
  assert.deepEqual((await readApiOperationInput(compiled, input('{"value":5}', "text/plain"), url, response)).body, { value: 5 });
  const strict = compileApiOperation({ ...definition, contract: { ...contract, request: { ...contract.request,
    body: { kind: "json", schema: { type: "object" }, maxBytes: 1024 } } } });
  await assert.rejects(readApiOperationInput(strict, input("", ""), url, response), { code: "API_MEDIA_TYPE_UNSUPPORTED" });
  await assert.rejects(readApiOperationInput(strict, input(""), url, response), { code: "API_JSON_INVALID" });
  assert.throws(() => compileApiOperation({ ...definition, contract: { ...contract, request: { ...contract.request,
    body: { kind: "json", schema: { type: "integer" }, maxBytes: 1024, emptyValue: {} } } } }), /empty-body value/);
  const registry = new ManagerPluginRouteRegistry(); const registration = registry.registerOperations("fixture", [definition]);
  const openapi = (await apiCatalogOpenApi(registry.catalogSnapshot())) as any;
  const body = openapi.paths["/api/example/records/{recordId}"].post.requestBody;
  assert.equal(body.required, false); assert.deepEqual(body["x-rabiroute-body"].emptyValue, { value: 3 });
  assert.deepEqual(Object.keys(body.content), ["*/*"]);
  await registration.dispose();
});

test("one immutable contract validates input and exports the same schema", async () => {
  const source = fixtureApiContract();
  const op = compileApiOperation({ contract: source, handler: () => ({ status: 200, body: { ok: true, value: 1 } }) });
  assert.ok(Object.isFrozen(op.contract.request.body));
  assert.notEqual(op.contract, source);
  assert.equal(apiDigest({ b: 1, a: 2 }), apiDigest({ a: 2, b: 1 }));
  const parsed = await readApiOperationInput(op, input('{"value":2}'), new URL("http://localhost/api/example/records/one"), {} as ServerResponse);
  assert.deepEqual(parsed.body, { value: 2 });
  assert.equal(parsed.path.recordId, "one");
  await assert.rejects(readApiOperationInput(op, input('{"value":-1}'), parsed.url, parsed.response), { code: "API_REQUEST_SCHEMA_INVALID", field: "body" });
  await assert.rejects(readApiOperationInput(op, input('{"value":1,"extra":"secret"}'), parsed.url, parsed.response), error => {
    assert.ok(error instanceof Error); assert.equal(error.message.includes("secret"), false); return true;
  });
  assert.throws(() => validateApiOperationResult(op, { status: 200, body: { ok: true } }), { code: "API_RESPONSE_SCHEMA_INVALID" });
  assert.throws(() => validateApiOperationResult(op, { status: 201, body: {} }), { code: "API_RESPONSE_STATUS_UNDECLARED" });
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("example", [{ contract: source, handler: () => ({ status: 200, body: { ok: true, value: 1 } }) }]);
  const snapshot = registry.catalogSnapshot();
  const spec = (await apiCatalogOpenApi(snapshot)) as { paths: Record<string, { post: Record<string, unknown> }> };
  const exported = spec.paths["/api/example/records/{recordId}"]!.post;
  assert.deepEqual(exported["x-rabiroute-request"], op.contract.request);
  assert.equal(snapshot.coverage.complete, true);
  assert.equal(snapshot.coverage.scope, "registered-routes");
  assert.equal(snapshot.coverage.globalCoverage, "not-proven", "An empty registry gap list cannot prove coverage of dispatch outside the registry.");
  await registration.dispose();
});

test("invalid schema, remote refs, missing responses and ambiguous operations reject registration without publication", () => {
  const registry = new ManagerPluginRouteRegistry();
  const definition = (contract: ApiOperationContract): ApiOperationDefinition => ({ contract, handler: () => ({ status: 200, body: {} }) });
  const before = registry.catalogSnapshot();
  assert.throws(() => registry.registerOperations("bad", [definition(fixtureApiContract({ request: {
    ...fixtureApiContract().request, query: { type: "invalid" }
  } }))]));
  assert.throws(() => registry.registerOperations("bad", [definition(fixtureApiContract({ responses: {} }))]));
  assert.throws(() => registry.registerOperations("bad", [definition(fixtureApiContract({ request: {
    ...fixtureApiContract().request, query: { $ref: "https://example.invalid/remote-schema" }
  } }))]));
  assert.throws(() => registry.registerOperations("bad", [definition(fixtureApiContract()), definition(fixtureApiContract())]), /operationId already registered/);
  assert.throws(() => registry.registerOperations("bad", [definition(fixtureApiContract({ aliases: ["example.record.write"] }))]), /Duplicate API operation alias/);
  assert.throws(() => registry.registerOperations("bad", [definition(fixtureApiContract({ aliases: ["legacy-id"] })), definition(fixtureApiContract({
    operationId: "legacy-id", pathTemplate: "/api/different/records/:recordId"
  }))]), /operationId already registered/);
  assert.throws(() => registry.registerOperations("bad", [definition(fixtureApiContract({ aliases: ["https://example.invalid?credential=value"] }))]), /Invalid API operation aliases/);
  assert.equal(registry.catalogSnapshot(), before);
});

test("body limits, query repetitions, media types and malformed JSON are enforced before the owner", async () => {
  const op = compileApiOperation({ contract: fixtureApiContract(), handler: () => ({ status: 200, body: {} }) });
  const url = new URL("http://localhost/api/example/records/one");
  const response = {} as ServerResponse;
  await assert.rejects(readApiOperationInput(op, input('{}'.repeat(600)), url, response), { code: "API_REQUEST_TOO_LARGE" });
  await assert.rejects(readApiOperationInput(op, input('{}', 'text/plain'), url, response), { code: "API_MEDIA_TYPE_UNSUPPORTED" });
  await assert.rejects(readApiOperationInput(op, input('{'), url, response), { code: "API_JSON_INVALID" });
  await assert.rejects(readApiOperationInput(op, input('{"value":1}'), new URL(url+'?extra=a&extra=b'), response), { field: "query" });
});

test("unmigrated prefix routes remain explicit coverage gaps and internal contracts stay out of public discovery", async () => {
  const registry = new ManagerPluginRouteRegistry();
  registry.register("unmigrated", [{ routeId: "prefix", match: { kind: "prefix", pathPrefix: "/other/" }, handler: () => false }]);
  const internal = registry.registerOperations("internal", [{ contract: fixtureApiContract({ exposure: "internal" }), handler: () => ({ status: 200, body: {} }) }]);
  const catalog = registry.catalogSnapshot();
  assert.equal(catalog.coverage.complete, false);
  assert.equal(catalog.operations.length, 0);
  assert.equal(catalog.coverage.gaps[0]?.reason, "executable-contract-missing");
  await internal.dispose();
});

test("framework errors are exported without dropping the owner's binary responses or required headers", () => {
  const contract = fixtureApiContract({ responses: { "200": fixtureApiContract().responses["200"]!, "400": {
    mediaType: "application/octet-stream", headers: { type: "object", required: ["x-record-version"],
      properties: { "x-record-version": { type: "string" } }, additionalProperties: true }
  } } });
  const operation = compileApiOperation({ contract, handler: () => ({ status: 200, body: {} }) });
  const selected = validateApiOperationResult(operation, { status: 400, body: Buffer.from("owner response"), headers: { "x-record-version": "1" } });
  assert.equal(selected.mediaType, "application/octet-stream");
  assert.throws(() => validateApiOperationResult(operation, { status: 400, body: Buffer.from("owner response") }), { code: "API_RESPONSE_SCHEMA_INVALID" });
  const failure = apiContractFailure(operation, new ApiContractError(413, "API_REQUEST_TOO_LARGE", "body", contract.operationId));
  assert.equal(validateApiOperationResult(operation, failure).mediaType, "application/json");
  assert.ok(operation.contract.responses["400"]?.alternatives?.some(value => value.mediaType === "application/json"));
});
