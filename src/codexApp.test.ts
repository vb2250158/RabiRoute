import assert from "node:assert/strict";
import test from "node:test";
import { buildChildEnvWithNodeOnPath } from "./codexApp.js";

test("buildChildEnvWithNodeOnPath prepends bundled node directory on POSIX-like env", () => {
  const env = buildChildEnvWithNodeOnPath(
    { PATH: "/usr/bin", OTHER: "value" },
    "/opt/rabiroute/node/bin/node",
    ":"
  );

  assert.equal(env.PATH, "/opt/rabiroute/node/bin:/usr/bin");
  assert.equal(env.OTHER, "value");
});

test("buildChildEnvWithNodeOnPath preserves Windows Path key and removes duplicate variants", () => {
  const env = buildChildEnvWithNodeOnPath(
    { Path: "C:\\Windows\\System32", PATH: "ignored", OTHER: "value" },
    "C:\\Tools\\node\\node.exe",
    ";"
  );

  assert.equal(env.Path, "C:\\Tools\\node;C:\\Windows\\System32");
  assert.equal(env.PATH, undefined);
  assert.equal(env.OTHER, "value");
});
