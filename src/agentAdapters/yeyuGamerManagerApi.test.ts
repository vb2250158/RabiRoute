import assert from "node:assert/strict";
import test from "node:test";
import * as recovered from "./yeyuGamerManagerApi.js";
import * as canonical from "../integrations/yeyuGamer/managerApi.js";

test("recovered import path exposes only the canonical plugin client", () => {
  assert.deepEqual(Object.keys(recovered).sort(), Object.keys(canonical).sort());
  for (const name of Object.keys(canonical) as Array<keyof typeof canonical>) {
    assert.equal(recovered[name], canonical[name]);
  }
  assert.equal("enabled" in recovered.yeyuGamerManagerConfigSchema.properties, false);
});
