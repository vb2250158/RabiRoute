import assert from "node:assert/strict";
import test from "node:test";
import {
  planStorageGenerationLeaseFromEnvironment,
  verifyPlanStorageGenerationLease
} from "./planStorageGenerationFence.js";

const applicationGenerationId = "5e5e60cc-f768-4548-b70f-4d3b155d032e";
const managerInstanceId = "d31d593a-833e-4947-a921-a57674a1ee09";
const managerBaseUrl = "http://127.0.0.1:5188";

function environment(): NodeJS.ProcessEnv {
  return {
    RABIROUTE_APPLICATION_GENERATION_ID: applicationGenerationId,
    RABIROUTE_MANAGER_INSTANCE_ID: managerInstanceId,
    GATEWAY_MANAGER_URL: managerBaseUrl
  };
}

function health(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    applicationGenerationId,
    managerInstanceId,
    managerBaseUrl,
    backgroundLifecycle: {
      planStorageStartup: { state: "ready" }
    },
    ...overrides
  };
}

test("plan-storage generation lease reuses the active dynamic Manager READY tuple", async () => {
  const lease = planStorageGenerationLeaseFromEnvironment(environment());
  let requestedUrl = "";
  let requestedHeaders: Headers | undefined;
  await verifyPlanStorageGenerationLease(lease, {
    fetch: async (input, init) => {
      requestedUrl = String(input);
      requestedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify(health()), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  assert.equal(requestedUrl, `${managerBaseUrl}/health`);
  assert.equal(
    requestedHeaders?.get("x-rabiroute-expected-application-generation-id"),
    applicationGenerationId
  );
  assert.equal(
    requestedHeaders?.get("x-rabiroute-expected-manager-instance-id"),
    managerInstanceId
  );
});

test("plan-storage generation lease fails closed without both Manager identities", () => {
  const missingManager = environment();
  delete missingManager.RABIROUTE_MANAGER_INSTANCE_ID;
  assert.throws(
    () => planStorageGenerationLeaseFromEnvironment(missingManager),
    /RABIROUTE_MANAGER_INSTANCE_ID/
  );
  assert.throws(
    () => planStorageGenerationLeaseFromEnvironment({
      ...environment(),
      GATEWAY_MANAGER_URL: "http://192.0.2.8:5188"
    }),
    /loopback Manager origin/
  );
});

test("plan-storage generation lease rejects stale identity and an unready storage gate", async () => {
  const lease = planStorageGenerationLeaseFromEnvironment(environment());
  await assert.rejects(
    verifyPlanStorageGenerationLease(lease, {
      fetch: async () => new Response(JSON.stringify(health({
        managerInstanceId: "another-manager-instance"
      })), { status: 200 })
    }),
    /identity changed/
  );
  await assert.rejects(
    verifyPlanStorageGenerationLease(lease, {
      fetch: async () => new Response(JSON.stringify(health({
        backgroundLifecycle: { planStorageStartup: { state: "degraded" } }
      })), { status: 200 })
    }),
    /not ready: degraded/
  );
});
