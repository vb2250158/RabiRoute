import test from "node:test";
import assert from "node:assert/strict";
import { resolveNpmCli } from "../lib/npm-cli.mjs";

for (const [label, platform, execPath, expected] of [
  ["Windows installer", "win32", "C:\\Node\\node.exe", "C:\\Node\\node_modules\\npm\\bin\\npm-cli.js"],
  ["macOS official installer", "darwin", "/usr/local/bin/node", "/usr/local/lib/node_modules/npm/bin/npm-cli.js"],
  ["macOS version manager", "darwin", "/home/user/.nvm/versions/node/v22/bin/node", "/home/user/.nvm/versions/node/v22/lib/node_modules/npm/bin/npm-cli.js"],
  ["Homebrew", "darwin", "/opt/homebrew/Cellar/node/22/bin/node", "/opt/homebrew/Cellar/node/22/libexec/lib/node_modules/npm/bin/npm-cli.js"],
  ["Linux", "linux", "/usr/bin/node", "/usr/lib/node_modules/npm/bin/npm-cli.js"]
]) test(`updates find npm in ${label} without shell PATH`, () => {
  assert.equal(resolveNpmCli({ execPath, platform, env: {}, isFile: filename => filename === expected }), expected);
});

test("explicit npm path is authoritative and missing npm fails before update dispatch", () => {
  assert.equal(resolveNpmCli({ platform: "linux", env: { npm_execpath: "/tools/npm-cli.js" }, isFile: filename => filename === "/tools/npm-cli.js" }), "/tools/npm-cli.js");
  assert.throws(() => resolveNpmCli({ platform: "linux", env: { npm_execpath: "relative/npm.js" }, isFile: () => true }), /absolute file/);
  assert.throws(() => resolveNpmCli({ platform: "linux", env: {}, isFile: () => false }), /npm CLI is missing/);
});
