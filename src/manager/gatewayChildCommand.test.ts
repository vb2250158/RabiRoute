import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolveGatewayChildCommand } from "./gatewayChildCommand.js";

test("gateway child uses the built entry directly when dist exists", () => {
  const rootDir = path.resolve("test-workspace", "RabiRoute");
  const distEntry = path.join(rootDir, "dist", "index.js");
  const command = resolveGatewayChildCommand(
    rootDir,
    ["--speech-message=one"],
    target => path.resolve(String(target)) === distEntry
  );

  assert.deepEqual(command, {
    command: process.execPath,
    args: [distEntry, "--speech-message=one"],
    shell: false
  });
});

test("gateway child uses node plus tsx directly in development without an npm shell", () => {
  const rootDir = path.resolve("test-workspace", "RabiRoute");
  const sourceEntry = path.join(rootDir, "src", "index.ts");
  const command = resolveGatewayChildCommand(
    rootDir,
    ["--speech-message=one"],
    () => false
  );

  assert.deepEqual(command, {
    command: process.execPath,
    args: ["--import", "tsx", sourceEntry, "--speech-message=one"],
    shell: false
  });
});
