import assert from "node:assert/strict";
import test from "node:test";
import { callNapCat, NapCatRequestError } from "./napcat.js";

test("NapCat failures preserve safe protocol diagnostics without treating a broken response as success", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  for (const scenario of ["http", "rejected", "invalid_response", "transport"] as const) {
    globalThis.fetch = (async () => {
      if (scenario === "transport") throw new Error("private-path", { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } });
      if (scenario === "http") return new Response("private-path", { status: 503 });
      if (scenario === "invalid_response") return new Response("broken-json");
      return Response.json({ status: "failed", retcode: 1200, message: "private-path" });
    }) as typeof fetch;
    await assert.rejects(callNapCat("upload_group_file", {}, { httpUrl: "http://fixture.invalid", accessToken: "fixture-secret" /* Public test-only fixture; not a real credential. */ }), error => {
      assert.ok(error instanceof NapCatRequestError);
      assert.equal(error.diagnostic.kind, scenario);
      assert.ok(!JSON.stringify(error.diagnostic).includes("private-path"));
      if (scenario === "transport") assert.equal(error.diagnostic.transportCode, "UND_ERR_HEADERS_TIMEOUT");
      return true;
    });
  }
});
