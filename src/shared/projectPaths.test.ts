import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { resolveProjectPath, toProjectRelativePath } from "./projectPaths.js";

test("toProjectRelativePath keeps paths inside the project portable", () => {
  const rootDir = path.resolve("C:/Projects/RabiRoute");

  assert.equal(toProjectRelativePath(path.join(rootDir, "data", "route"), rootDir), "data/route");
  assert.equal(toProjectRelativePath(rootDir, rootDir), ".");
  assert.equal(resolveProjectPath("data/route", rootDir), path.join(rootDir, "data", "route"));
});

test("toProjectRelativePath rebases stale same-workspace absolute paths", () => {
  const rootDir = path.resolve("C:/Projects/RabiRoute");

  assert.equal(toProjectRelativePath("D:/Projects/RabiRoute", rootDir), ".");
  assert.equal(toProjectRelativePath("D:/Projects/RabiRoute/data/route", rootDir), "data/route");
  assert.equal(toProjectRelativePath("D:/Projects", rootDir), "..");
  assert.equal(resolveProjectPath("D:/Projects/RabiRoute", rootDir), rootDir);
  assert.equal(resolveProjectPath("D:/Projects", rootDir), path.dirname(rootDir));
});

test("toProjectRelativePath leaves unrelated absolute paths absolute", () => {
  const rootDir = path.resolve("C:/Projects/RabiRoute");
  const external = path.resolve("D:/MonsterGirl");

  assert.equal(toProjectRelativePath(external, rootDir), external.replace(/\\/g, "/"));
  assert.equal(resolveProjectPath(external, rootDir), external);
});

test("toProjectRelativePath drops placeholder cwd values", () => {
  assert.equal(toProjectRelativePath("C:/Path/To/Your/Project", path.resolve("C:/Projects/RabiRoute")), undefined);
});
