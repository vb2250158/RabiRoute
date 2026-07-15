import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("remote bridge is a client of the local shared Runtime and never spawns Codex", () => {
  const source = fs.readFileSync(new URL("./codex-app-server-client.mjs", import.meta.url), "utf8");
  assert.match(source, /ws:\/\/127\.0\.0\.1:4510/);
  assert.doesNotMatch(source, /spawn\(|stdio:\/\//);
});
