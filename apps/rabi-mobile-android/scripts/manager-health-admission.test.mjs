import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Source-contract regression: these Kotlin entry points own the exact pre-dispatch guard.
// This does not claim Android device/runtime acceptance.
for (const name of ["RabiManagerHttpTransport.kt", "RabiPhoneEyeBridge.kt"]) {
  test(`${name}: writes require original live identity without unrelated capability readiness`, () => {
    const source = fs.readFileSync(new URL(`../app/src/main/java/com/rabi/link/transport/${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /health\.(?:opt|get)Boolean\("requiredReady"\)/);
    assert.match(source, /health\.(?:opt|get)Boolean\("live"\)/);
    assert.match(source, /health\.(?:opt|get)String\("state"\) in listOf\("healthy","degraded"\)/);
    for (const identity of ["applicationGenerationId", "managerInstanceId"]) {
      assert.match(source, new RegExp(`(?:opt|get)String\\("${identity}"\\)`));
    }
    assert.ok(source.includes("x-rabiroute-expected-application-generation-id"));
    assert.ok(source.includes("x-rabiroute-expected-manager-instance-id"));
    assert.ok(source.includes("delegatedManagerGeneration"));
    assert.match(source, /(?:after|value)\.(?:opt|get)String\("applicationGenerationId"\)\s*==\s*(?:before|originalMeta)\.(?:opt|get)String\("applicationGenerationId"\)/);
    assert.match(source, /(?:after|value)\.(?:opt|get)String\("managerInstanceId"\)\s*==\s*(?:before|originalMeta)\.(?:opt|get)String\("managerInstanceId"\)/);
  });
}
