import assert from "node:assert/strict";
import test from "node:test";
import { discoverManagerBaseUrl } from "./discover-manager-url.mjs";

test("explicit dynamic Manager URL wins without invoking Host", () => {
  const actual = discoverManagerBaseUrl({
    explicit: "http://127.0.0.1:49321/path",
    env: {},
    spawnSync: () => { throw new Error("must not run"); }
  });
  assert.equal(actual, "http://127.0.0.1:49321");
});

test("Host status supplies the current generation Manager URL", () => {
  const actual = discoverManagerBaseUrl({
    platform: "win32",
    env: { RABIROUTE_HOST_EXE: import.meta.filename },
    spawnSync: (_command, args) => ({
      status: 0,
      stdout: JSON.stringify({
        ok: true,
        state: "healthy",
        managerBaseUrl: "http://127.0.0.1:51234",
        applicationGenerationId: "generation-a",
        managerInstanceId: "manager-a"
      }),
      stderr: ""
    })
  });
  assert.deepEqual(actual, "http://127.0.0.1:51234");
});

test("discovery fails closed when no endpoint source exists", () => {
  assert.throws(
    () => discoverManagerBaseUrl({ platform: "linux", env: {} }),
    /Manager URL is not configured/
  );
});

test("Host status without generation identity is rejected", () => {
  assert.throws(
    () => discoverManagerBaseUrl({
      platform: "win32",
      env: { RABIROUTE_HOST_EXE: import.meta.filename },
      spawnSync: () => ({ status: 0, stdout: JSON.stringify({ managerBaseUrl: "http://127.0.0.1:51234" }) })
    }),
    /healthy, complete Manager READY identity/
  );
});
