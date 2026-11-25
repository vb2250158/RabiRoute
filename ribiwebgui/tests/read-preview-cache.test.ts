import assert from "node:assert/strict";
import test from "node:test";
import { clearReadPreviews, readPreview, writePreview } from "../src/readPreviewCache";

test("previews survive reads across modules and stay scoped to source and API origin", t => {
  const entries = new Map<string, string>();
  const browser = {
    __RABI_MANAGER_API_BASE__: "/manage/account-a/computer-a",
    sessionStorage: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
      removeItem: (key: string) => entries.delete(key)
    }
  };
  t.mock.method(Date, "now", () => 100);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });

  const local = ["role-catalog", ""];
  const remote = ["role-catalog", "peer-a"];
  writePreview(local, [{ title: "Local" }]);
  writePreview(remote, [{ title: "Peer" }]);
  assert.deepEqual(readPreview(local), [{ title: "Local" }]);
  assert.deepEqual(readPreview(remote), [{ title: "Peer" }]);
  browser.__RABI_MANAGER_API_BASE__ = "/manage/account-b/computer-a";
  assert.equal(readPreview(local), undefined);
  browser.__RABI_MANAGER_API_BASE__ = "/manage/account-a/computer-a";
  writePreview(remote, undefined);
  assert.equal(readPreview(remote), undefined);
  assert.deepEqual(readPreview(local), [{ title: "Local" }]);

  t.mock.method(Date, "now", () => 100 + 86_400_000);
  assert.equal(readPreview(local), undefined);
  writePreview(local, []);
  assert.deepEqual(readPreview(local), []);
  clearReadPreviews();
  assert.equal(readPreview(local), undefined);
});
