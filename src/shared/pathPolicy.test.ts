import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertExistingPathWithinRoots,
  assertPathWithinRoot,
  isUncPath,
  isPathWithinRoot,
  normalizePathForComparison,
  requiresWorkerFilesystemAccess,
  resolveRelativePathWithinRoot
} from "./pathPolicy.js";

test("UNC detection is lexical and never needs a filesystem probe", () => {
  assert.equal(isUncPath("\\\\example-host\\example-share\\project"), true);
  assert.equal(isUncPath("//example-host/example-share/project"), true);
  assert.equal(isUncPath("\\\\?\\UNC\\example-host\\example-share\\project"), true);
  assert.equal(isUncPath("\\\\?\\C:\\ExampleApp"), false);
  assert.equal(isUncPath("G:\\ExampleApp"), false);
  assert.equal(isUncPath("/var/lib/rabiroute"), false);
});

test("worker filesystem access only trusts the configured Windows system drive", () => {
  assert.equal(requiresWorkerFilesystemAccess("\\\\example-host\\example-share\\project", "C:"), true);
  assert.equal(requiresWorkerFilesystemAccess("C:\\ExampleApp\\data", "C:"), false);
  assert.equal(requiresWorkerFilesystemAccess("\\\\?\\C:\\ExampleApp\\data", "C:"), false);
  assert.equal(requiresWorkerFilesystemAccess("G:\\ExampleApp\\data", "C:"), true);
  assert.equal(requiresWorkerFilesystemAccess("Z:/ExampleShare/Project", "C:"), true);
  assert.equal(requiresWorkerFilesystemAccess("C:\\ExampleApp\\data", ""), true);
  assert.equal(requiresWorkerFilesystemAccess("/var/lib/rabiroute", "C:"), false);
});

test("path comparison treats Windows extended paths as the same workspace", (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows extended path prefixes are Windows-specific.");
    return;
  }
  assert.equal(
    normalizePathForComparison("C:\\Data\\CottonProject\\PangHu"),
    normalizePathForComparison("\\\\?\\C:\\Data\\CottonProject\\PangHu")
  );
  assert.equal(
    normalizePathForComparison("\\\\server\\share\\project"),
    normalizePathForComparison("\\\\?\\UNC\\server\\share\\project")
  );
});

test("path policy accepts paths inside a configured root and rejects sibling prefixes", () => {
  const root = path.resolve("C:/Projects/RabiRoute/data");
  assert.equal(isPathWithinRoot(root, path.join(root, "roles", "DemoPersona")), true);
  assert.equal(isPathWithinRoot(root, `${root}-backup`), false);
  assert.throws(() => assertPathWithinRoot(root, `${root}-backup`), /escapes configured root/);
});

test("relative path resolution rejects absolute paths and traversal", () => {
  const root = path.resolve("C:/Projects/RabiRoute");
  assert.equal(
    resolveRelativePathWithinRoot(root, "docs/guide.md"),
    path.join(root, "docs", "guide.md")
  );
  assert.throws(() => resolveRelativePathWithinRoot(root, path.resolve(root, "docs/guide.md")), /must be relative/);
  assert.throws(() => resolveRelativePathWithinRoot(root, "../outside.md"), /escapes configured root/);
});

test("existing path validation resolves symlinks before applying root containment", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-path-policy-"));
  const allowed = path.join(root, "allowed");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-path-outside-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(allowed, { recursive: true });
  const target = path.join(outside, "private.md");
  fs.writeFileSync(target, "private", "utf8");
  let link = path.join(allowed, "linked.md");
  try {
    fs.symlinkSync(target, link, "file");
  } catch (fileLinkError) {
    const linkedDirectory = path.join(allowed, "linked-directory");
    try {
      fs.symlinkSync(outside, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
      link = path.join(linkedDirectory, "private.md");
    } catch (directoryLinkError) {
      t.skip(`filesystem link creation is unavailable: ${String(fileLinkError)}; ${String(directoryLinkError)}`);
      return;
    }
  }
  assert.throws(() => assertExistingPathWithinRoots(link, [allowed]), /escapes every configured root/);
});
