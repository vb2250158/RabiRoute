import assert from "node:assert/strict";
import test from "node:test";
import { mutateRole } from "../src/roleConfigurationClient";

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
