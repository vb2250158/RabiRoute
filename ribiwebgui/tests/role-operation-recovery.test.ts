import assert from "node:assert/strict";
import test from "node:test";
import { mutateRole, type RoleRequestFailure } from "../src/roleConfigurationClient";

function installStorage(t: test.TestContext, storage: Map<string, string>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  t.after(() => { if (previous) Object.defineProperty(globalThis, "sessionStorage", previous); else Reflect.deleteProperty(globalThis, "sessionStorage"); });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: (key: string) => storage.get(key) || null,
    setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key)
  } });
}

test("recovering an older uncertain save cannot report that a newer draft was saved", async t => {
  const key = "rabi:role-operation::Example:configuration";
  const earlier = { expectedRevision: "before", config: { recentMessageLimit: 9 } };
  const storage = new Map([[key, JSON.stringify({ id: "original-operation", body: earlier })]]);
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  t.after(() => { if (previousStorage) Object.defineProperty(globalThis, "sessionStorage", previousStorage); else Reflect.deleteProperty(globalThis, "sessionStorage"); });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (key: string) => storage.get(key) || null,
    setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } });
  t.mock.method(globalThis, "fetch", async (_url: unknown, options?: RequestInit) => {
    assert.equal((options?.headers as Record<string, string>)["idempotency-key"], "original-operation");
    assert.deepEqual(JSON.parse(String(options?.body)), earlier);
    return Response.json({ code: 0, data: { roleId: "Example", revision: "confirmed", config: earlier.config } });
  });
  const draft = { expectedRevision: "before", config: { recentMessageLimit: 37 } };
  await assert.rejects(mutateRole("Example", "configuration", draft), (error: any) => {
    assert.equal(error.confirmedRole.revision, "confirmed");
    assert.match(error.message, /草稿已保留/); return true;
  });
  assert.equal(draft.config.recentMessageLimit, 37);
  assert.equal(storage.has(key), false);
});

for (const response of [
  { status: 403, uncertain: true },
  { status: 409, uncertain: true },
  { status: 403, mutationOutcome: "unknown" },
  { status: 409, mutationOutcome: "unknown" },
  { status: 409, uncertain: true, mutationOutcome: "not_started" }
]) {
  test(`uncertain role ${response.status} ${JSON.stringify(response)} retains original key/payload until readback recovery`, async t => {
    const key = "rabi:role-operation::Example:configuration", original = { expectedRevision: "original-revision", config: { recentMessageLimit: 9 } };
    const record = JSON.stringify({ id: "original-operation", body: original }), storage = new Map([[key, record]]);
    installStorage(t, storage);
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (_url: unknown, options?: RequestInit) => {
      assert.equal((options?.headers as Record<string, string>)["idempotency-key"], "original-operation");
      assert.deepEqual(JSON.parse(String(options?.body)), original);
      calls++;
      return calls === 1 ? Response.json({ code: -1, message: "Original request needs reconciliation", ...response }, { status: response.status })
        : Response.json({ code: 0, data: { roleId: "Example", revision: "reconciled", config: original.config } });
    });
    await assert.rejects(mutateRole("Example", "configuration", original), error => {
      const failure = error as Error & RoleRequestFailure;
      assert.equal(failure.status, response.status);
      assert.equal(failure.uncertain, "uncertain" in response && response.uncertain === true);
      assert.equal(failure.mutationOutcome, "mutationOutcome" in response ? response.mutationOutcome : undefined);
      return true;
    });
    assert.equal(storage.get(key), record);
    const changedDraft = { ...original, config: { recentMessageLimit: 37 } };
    await assert.rejects(mutateRole("Example", "configuration", changedDraft), (error: any) => error.confirmedRole.revision === "reconciled");
    assert.equal(calls, 2);
    assert.equal(storage.has(key), false);
    assert.equal(changedDraft.config.recentMessageLimit, 37);
  });
}

for (const status of [400, 403, 409, 412]) {
  test(`deterministic not_started role ${status} clears its rejected recovery record`, async t => {
    const key = "rabi:role-operation::Example:configuration", storage = new Map<string, string>();
    installStorage(t, storage);
    t.mock.method(globalThis, "fetch", async () => Response.json({ code: -1, mutationOutcome: "not_started" }, { status }));
    await assert.rejects(mutateRole("Example", "configuration", { expectedRevision: "old-revision", config: {} }));
    assert.equal(storage.has(key), false);
  });
}
