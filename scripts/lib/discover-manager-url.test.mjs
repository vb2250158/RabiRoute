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
    () => discoverManagerBaseUrl({ platform: "darwin", env: {} }),
    /Manager URL is not configured/
  );
});

test("Linux discovery uses live Host status and accepts required-ready degraded state", () => {
  const actual = discoverManagerBaseUrl({ platform: "linux", env: {}, spawnSync: (command, args) => {
    assert.equal(command, process.execPath);
    assert.match(args[0], /linux-host\.mjs$/);
    assert.deepEqual(args.slice(1), ["--command", "status", "--json"]);
    return { status: 0, stdout: JSON.stringify({ ok: true, state: "degraded", managerBaseUrl: "http://127.0.0.1:51234", applicationGenerationId: "generation-a", managerInstanceId: "manager-a" }) };
  } });
  assert.equal(actual, "http://127.0.0.1:51234");
  assert.throws(() => discoverManagerBaseUrl({ platform: "linux", env: {}, spawnSync: () => ({ status: 1, stdout: "" }) }), /offline/);
});

const ready = { ok: true, state: "healthy", managerBaseUrl: "http://127.0.0.1:51234", applicationGenerationId: "generation-a", managerInstanceId: "manager-a" };
function fixture(statuses, overrides = {}) {
  let elapsed = 0; let calls = 0; const waits = []; const budgets = [];
  const options = {
    platform: "win32", env: { RABIROUTE_HOST_EXE: import.meta.filename }, timeoutMs: 1000, pollIntervalMs: 100,
    now: () => elapsed,
    sleep: ms => { waits.push(ms); elapsed += ms; },
    spawnSync: (_command, _args, options) => {
      budgets.push(options.timeout);
      const value = statuses[Math.min(calls++, statuses.length - 1)];
      return value.result || { status: 0, stdout: JSON.stringify(value) };
    }, ...overrides
  };
  return { resolve: () => discoverManagerBaseUrl(options), calls: () => calls, waits, budgets };
}

test("published identity is discoverable independently of aggregate Host state on every platform", () => {
  for (const platform of ["win32", "linux"]) {
    for (const state of ["healthy", "degraded", "starting", "future-state"]) {
      assert.equal(fixture([{ ...ready, state }], { platform }).resolve(), ready.managerBaseUrl);
    }
  }
});

test("discovery rereads a recovering Host and uses only the newly complete generation", () => {
  const f = fixture([{ ok: true, state: "starting" }, { ...ready, managerInstanceId: "" }, { ...ready, applicationGenerationId: "generation-b", managerBaseUrl: "http://127.0.0.1:51235" }]);
  assert.equal(f.resolve(), "http://127.0.0.1:51235");
  assert.equal(f.calls(), 3);
  assert.deepEqual(f.waits, [100, 100]);
  assert.deepEqual(f.budgets, [1000, 900, 800]);
});

test("missing or blank publication stops at the overall deadline", () => {
  const f = fixture([{ ...ready, state: "starting", applicationGenerationId: " " }], { timeoutMs: 250 });
  assert.throws(f.resolve, /within 250 ms.*state=starting.*still pending/);
  assert.equal(f.calls(), 3);
  assert.deepEqual(f.waits, [100, 100, 50]);
  assert.deepEqual(f.budgets, [250, 150, 50]);
});

test("offline, malformed JSON, process failure and query timeout retain distinct diagnostics", () => {
  for (const [result, message] of [
    [{ status: 1, stdout: "" }, /offline.*exit=1/],
    [{ status: 0, stdout: "not-json" }, /invalid status JSON/],
    [{ error: { code: "ETIMEDOUT" } }, /query timed out/],
    [{ error: { code: "EACCES" } }, /query failed \(EACCES\)/],
    [{ status: 0, stdout: JSON.stringify({ ok: false }) }, /status is unavailable/]
  ]) {
    const f = fixture([{ result }]);
    assert.throws(f.resolve, message);
    assert.equal(f.calls(), 1);
    assert.deepEqual(f.waits, []);
  }
});

test("explicit and environment URLs retain priority without querying Host", () => {
  const spawnSync = () => { throw new Error("must not query Host"); };
  assert.equal(discoverManagerBaseUrl({ env: { RABIROUTE_MANAGER_URL: "http://localhost:54321", GATEWAY_MANAGER_URL: "http://localhost:54322" }, spawnSync }), "http://localhost:54321");
  assert.equal(discoverManagerBaseUrl({ explicit: "http://localhost:54323", env: { RABIROUTE_MANAGER_URL: "http://localhost:54321" }, spawnSync }), "http://localhost:54323");
  assert.throws(() => fixture([ready], { timeoutMs: Infinity }).resolve(), /bounded/);
  assert.throws(() => fixture([ready], { pollIntervalMs: 0 }).resolve(), /bounded/);
  assert.throws(() => fixture([{ ...ready, managerBaseUrl: "http://192.0.2.10:51234" }]).resolve(), /loopback/);
});
