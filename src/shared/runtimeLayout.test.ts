import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolveRuntimeLayout } from "./runtimeLayout.js";

test("runtime layout keeps source-mode package and state under one explicit root", () => {
  const root = path.resolve("source-fixture");
  assert.deepEqual(resolveRuntimeLayout(root, {}), { packageRoot: root, stateRoot: root });
});

test("runtime layout separates immutable version package from stable application state", () => {
  const packageRoot = path.resolve("versions", "0.3.0-test");
  const stateRoot = path.resolve("application-state");
  assert.deepEqual(resolveRuntimeLayout(path.resolve("fallback"), {
    RABIROUTE_PACKAGE_ROOT: packageRoot,
    RABIROUTE_STATE_ROOT: stateRoot
  }), { packageRoot, stateRoot });
});

test("runtime layout rejects cwd-relative environment roots", () => {
  assert.throws(
    () => resolveRuntimeLayout(path.resolve("fallback"), { RABIROUTE_STATE_ROOT: "data" }),
    /RABIROUTE_STATE_ROOT must be an absolute path/
  );
  assert.throws(
    () => resolveRuntimeLayout("relative-default", {}),
    /defaultPackageRoot must be an absolute path/
  );
});
