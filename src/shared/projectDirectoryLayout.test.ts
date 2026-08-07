import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { projectDirectoryLayout } from "./projectDirectoryLayout.js";

test("project directory layout separates software examples, private data, runtime state, imports, and logs", () => {
  const root = path.resolve("C:/Projects/RabiRoute");
  const layout = projectDirectoryLayout(root);
  assert.equal(layout.routeDataRoot, path.join(root, "data", "route"));
  assert.equal(layout.personaDataRoot, path.join(root, "data", "roles"));
  assert.equal(layout.runtimeStateRoot, path.join(root, "data", ".runtime"));
  assert.equal(layout.runtimeImportRoot, path.join(root, "data", ".runtime", "imports"));
  assert.equal(layout.managerLogRoot, path.join(root, "logs", "manager"));
  assert.equal(layout.publicExampleDataRoot, path.join(root, "examples", "data"));
});
