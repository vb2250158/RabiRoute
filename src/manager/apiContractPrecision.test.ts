import assert from "node:assert/strict";
import test from "node:test";
import { apiContractPrecision, apiSchemaPrecision } from "./apiContractPrecision.js";
import { projectApiHelp } from "./apiDiscoveryRoutes.js";
import { compileApiContract } from "./apiOperationContract.js";
import { fixtureApiContract } from "./apiOperationContractFixtures.js";

test("schema precision distinguishes unconstrained provider payloads, open structures and closed declared shapes", () => {
  assert.equal(apiSchemaPrecision(true), "unconstrained");
  assert.equal(apiSchemaPrecision({ description: "Provider defines payload dynamically." }), "unconstrained");
  assert.equal(apiSchemaPrecision({ type: "object", properties: { value: { type: "string" } } }), "open-structure");
  assert.equal(apiSchemaPrecision({ type: "object", additionalProperties: false, properties: { provider: true } }), "partially-constrained-structure");
  assert.equal(apiSchemaPrecision({ type: "object", additionalProperties: false, properties: { value: { type: "string" } } }), "closed-structure");
});

test("discovery reports runtime schema precision without claiming native DTO completeness", () => {
  const operation = compileApiContract({ contract: fixtureApiContract() });
  const help = projectApiHelp({ contract: operation.contract, contractDigest: operation.digest, owner: { instanceId: "fixture" } }).help;
  assert.equal(help.auditLevel, "runtime-schema"); assert.equal(help.coverage.exactRequestSchema, false); assert.equal(help.coverage.exactResponseSchema, false);
  assert.equal(help.coverage.request.body.precision, "closed-structure");
  assert.equal(help.coverage.businessValidation, "server-owned"); assert.equal(help.coverage.completeness, "not-proven");
  assert.deepEqual(help.coverage.unproven, ["complete-native-request-dto", "complete-native-response-dto"]);
});

test("opaque native bodies, bytes and stream frames remain explicit rather than becoming fake response DTOs", () => {
  const base = fixtureApiContract();
  const precision = apiContractPrecision({ ...base, request: { ...base.request, body: { kind: "passthrough" } }, responses: {
    default: { mediaType: "*/*", passthrough: true },
    "206": { mediaType: "application/octet-stream", binary: { maxBytes: 4096 } },
    "200": { mediaType: "text/event-stream", stream: { framing: "sse-json", maxFrameBytes: 4096,
      frameSchema: true, completion: "EOF", cancellation: "Close" } }
  } });
  assert.equal(precision.request.body.precision, "opaque-native");
  assert.deepEqual(precision.responses.default, [{ mode: "opaque-native" }]);
  assert.deepEqual(precision.responses["206"], [{ mode: "native-bytes", byteLimits: { maxBytes: 4096 } }]);
  assert.deepEqual(precision.responses["200"], [{ mode: "stream", framing: "sse-json", frameSchema: "unconstrained" }]);
});
