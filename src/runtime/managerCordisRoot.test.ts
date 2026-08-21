import assert from "node:assert/strict";
import test from "node:test";
import {
  createManagerCordisRoot,
  getBuiltinManagerCordisRoot
} from "./managerCordisRoot.js";

test("Manager Cordis root uses Manager diagnostics", async () => {
  const root = createManagerCordisRoot();

  await assert.rejects(
    root.ensure("  ", async () => "unused"),
    /Manager Cordis runtime key is required/
  );

  const disposing = root.dispose();
  await assert.rejects(
    root.ensure("late", async () => "late"),
    /Manager Cordis root is disposing/
  );
  await disposing;
});

test("Manager builtin Cordis root is shared until disposed", async () => {
  const first = getBuiltinManagerCordisRoot();
  const second = getBuiltinManagerCordisRoot();

  assert.strictEqual(first, second);
  await first.dispose();

  const replacement = getBuiltinManagerCordisRoot();
  assert.notStrictEqual(replacement, first);
  assert.equal(replacement.disposed, false);
  assert.strictEqual(getBuiltinManagerCordisRoot(), replacement);
  await replacement.dispose();
});
