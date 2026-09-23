import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "agent-api-route-inventory.mjs");
const root = path.resolve(path.dirname(script), "../plugins/builtin");
const inventoryAt = directory => JSON.parse(execFileSync(process.execPath, [script, directory], { encoding: "utf8" }));
test("repository inventory statistics remain consistent as plugins grow", () => {
  const inventory = inventoryAt(root);
  assert.equal(inventory.schemaVersion, "1");
  assert.ok(inventory.managerFileCount > 0);
  assert.equal(inventory.counts.routeDeclarations, inventory.routeDeclarationCount);
  assert.equal(inventory.counts.exactMethodPaths, inventory.exactMethodPathCount);
  assert.equal(inventory.counts.dispatchScopes, inventory.dispatchScopeCount);
  assert.equal(inventory.counts.unresolved, inventory.unresolvedCount);
  assert.equal(inventory.unresolved.length, inventory.unresolvedCount);
  assert.equal(inventory.limitations.length, 3);
  assert.ok(inventory.exact.some(item => item.path === "/api/agent/help" && item.method === "GET"));
  assert.ok(inventory.exact.every(item => item.method !== "*"));
});
test("AST handles reordered and quoted properties, ignores comments, and reports dynamic declarations", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-inventory-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "manager.mjs"), `
    // { routeId: 'fake', kind: 'exact', path: '/fake', methods: ['DELETE'] }
    const routes = [
      { methods: ['GET', 'POST'], 'path': '/literal', "kind": 'exact', 'routeId': 'literal' },
      { routeId: 'prefix', kind: 'prefix', pathPrefix: '/scope' },
      { routeId: 'wildcard', kind: 'exact', path: '/wildcard', methods: ['*'] },
      { routeId: 'dynamic', kind: 'exact', path: computePath(), methods: ['GET'] },
      { routeId: 'methods', kind: 'exact', path: '/methods', methods: methodList },
      { routeId: 'spread', kind: 'exact', path: '/spread', methods: ['GET'], ...extra }
    ];
  `);
  const inventory = inventoryAt(directory);
  assert.deepEqual(inventory.counts, { routeDeclarations: 6, exactMethodPaths: 2, dispatchScopes: 1, unresolved: 4 });
  assert.deepEqual(inventory.exact.map(item => item.method), ["GET", "POST"]);
  assert.ok(inventory.exact.every(item => item.path === "/literal"));
  assert.equal(inventory.dispatchScopes[0].pathPrefix, "/scope");
  assert.ok(inventory.unresolved.some(item => item.reason.includes("wildcard")));
  assert.ok(!JSON.stringify(inventory).includes("/fake"));
});
