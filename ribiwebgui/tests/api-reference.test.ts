import assert from "node:assert/strict";
import test from "node:test";
import { fixtureApiContract } from "../../src/manager/apiOperationContractFixtures";
import { apiRequestTemplate, readApiReference, type ApiReferenceOperation } from "../src/docs/apiReferenceClient";

const operation = (id: string): ApiReferenceOperation => ({
  contract: fixtureApiContract({ operationId: id }), contractDigest: "sha256:example", owner: { instanceId: "example" }
});
const page = (operations: ApiReferenceOperation[], nextCursor = "") => ({ code: 0, data: {
  schemaVersion: "2", applicationGenerationId: "generation", managerInstanceId: "manager", catalogDigest: "digest", catalogRevision: 1,
  operations, nextCursor, coverage: { scope: "registered-routes", globalCoverage: "not-proven", complete: false, gaps: [] }
} });

test("reference follows opaque cursors and publishes all pages from the catalog", async () => {
  const requests: string[] = [];
  const fetcher: typeof fetch = async input => {
    requests.push(String(input));
    return Response.json(requests.length === 1 ? page([operation("example.first")], "opaque+/=") : page([operation("example.second")]));
  };
  const result = await readApiReference(new AbortController().signal, fetcher);
  assert.deepEqual(result.operations.map(value => value.contract.operationId), ["example.first", "example.second"]);
  assert.equal(new URL(requests[1], "https://example.invalid").searchParams.get("cursor"), "opaque+/=");
  assert(requests.every(value => value.startsWith("/api/agent/help?")));
});

test("a changed catalog rejects the incomplete result without replay or partial publication", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => ++calls === 1
    ? Response.json(page([operation("example.first")], "cursor"))
    : Response.json({ code: -1, message: "API_CATALOG_SNAPSHOT_CHANGED" }, { status: 409 });
  await assert.rejects(readApiReference(new AbortController().signal, fetcher), /API_CATALOG_SNAPSHOT_CHANGED/);
  assert.equal(calls, 2);
});

test("reference rejects a legacy catalog and forwards cancellation to the read", async () => {
  await assert.rejects(readApiReference(new AbortController().signal, async () => Response.json({ code: 0, data: { schemaVersion: "1" } })), /version: 1/);
  const controller = new AbortController();
  let received: AbortSignal | null | undefined;
  const fetcher: typeof fetch = async (_input, init) => {
    received = init?.signal;
    controller.abort();
    received?.throwIfAborted();
    throw new Error("expected cancellation");
  };
  await assert.rejects(readApiReference(controller.signal, fetcher), { name: "AbortError" });
  assert(received);
});

test("request templates preserve contract method, required query, native access, and body semantics", () => {
  const item = operation("example.write");
  item.contract = { ...item.contract, method: "*", request: { ...item.contract.request,
    query: { type: "object", required: ["revision"], properties: { revision: { type: "string" } } }
  } };
  item.access = { pathPrefix: "/api/native/", contractHeader: "x-native-contract", contractDigest: "native-digest" };
  const result = apiRequestTemplate(item);
  assert(result.includes("--request '<HTTP_METHOD>'"));
  assert(result.includes('/api/native/api/example/records/{recordId}?revision={revision}'));
  assert(result.includes("x-native-contract: native-digest"));
  assert(result.includes("--data '<JSON_BODY>'"));
  const read = apiRequestTemplate({ ...item, contract: { ...item.contract, method: "GET", request: { ...item.contract.request, body: { kind: "none" } } } });
  assert(!read.includes("--data"));
});
