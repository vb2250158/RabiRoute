import assert from "node:assert/strict";
import test from "node:test";
import { createPinia, setActivePinia } from "pinia";


test("a catalog refresh does not cancel the first-role lookup", async () => {
  Object.defineProperty(globalThis, "window", { value: { location: { pathname: "/", hash: "" } }, configurable: true });
  const { findFirstAvailableRole, useRoleStore } = await import("../src/stores/roleStore");
  setActivePinia(createPinia());
  const original = globalThis.fetch;
  let releaseFirst!: (response: Response) => void;
  const firstResponse = new Promise<Response>(resolve => { releaseFirst = resolve; });
  const page = (roleId: string) => Response.json({ code: 0, data: {
    roles: [{ roleId, title: roleId, archivedAt: null }], nextCursor: null
  } });
  let requests = 0;
  globalThis.fetch = async () => ++requests === 1 ? firstResponse : page("Refreshed");
  try {
    const first = findFirstAvailableRole("");
    const store = useRoleStore();
    await store.loadCatalog();
    releaseFirst(page("First"));
    assert.equal((await first)?.roleId, "First");
    assert.equal(store.catalog[0]?.roleId, "Refreshed");
  } finally { globalThis.fetch = original; }
});
