import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertEndpointOwnerDirectory, executeEndpointOnOwner } from "./ownerExecution.js";
import type { PreparedEndpointDelivery } from "./endpointDelivery.js";

test("owner directory checks existence rather than configured workspace membership", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "owner-directory-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.doesNotThrow(() => assertEndpointOwnerDirectory(directory));
  assert.throws(() => assertEndpointOwnerDirectory(undefined), /existing absolute/);
  assert.throws(() => assertEndpointOwnerDirectory("relative"), /existing absolute/);
  const file = path.join(directory, "file"); fs.writeFileSync(file, "fixture");
  assert.throws(() => assertEndpointOwnerDirectory(file), /existing absolute/);
  assert.throws(() => assertEndpointOwnerDirectory(path.join(directory, "missing")), /existing absolute/);
  const delivery = { target: { provider: "unimplemented" }, executionOptions: { cwd: directory } } as PreparedEndpointDelivery;
  let checks = 0;
  await assert.rejects(executeEndpointOnOwner(delivery, { allowedWorkspaces: [] }, () => { checks++; }), /no exact owner execution capability/);
  assert.equal(checks, 1);
  await assert.rejects(executeEndpointOnOwner(delivery, { allowedWorkspaces: [path.join(directory, "different")] }, () => {}), /no exact owner execution capability/);
});
