import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.join(repoRoot, ".github", "workflows", "release-remote-agent-windows.yml");

test("Remote Agent release installs locked dependencies before building assets", () => {
  const workflow = fs.readFileSync(workflowPath, "utf8");
  const installIndex = workflow.indexOf("npm ci");
  const buildIndex = workflow.indexOf("./scripts/build-remote-agent-windows-release.ps1");

  assert.notEqual(buildIndex, -1, "Remote Agent release build command is missing");
  assert.notEqual(
    installIndex,
    -1,
    "Remote Agent release must run npm ci on a clean GitHub runner before building"
  );
  assert.ok(
    installIndex < buildIndex,
    "Remote Agent release must install locked dependencies before invoking the build script"
  );
});
