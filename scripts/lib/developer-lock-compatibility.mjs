import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

// Only the application's version metadata may change without reinstalling dependencies.
function dependencyGraph(lock) {
  const value = JSON.parse(lock);
  if (!value || typeof value !== "object" || Array.isArray(value) || value.lockfileVersion !== 3) {
    throw new Error("Developer candidates require a valid v3 package lock.");
  }
  delete value.version;
  if (value.packages?.[""]) delete value.packages[""].version;
  return value;
}

export function assertDeveloperLocksCompatible(baseLock, buildLock) {
  if (!isDeepStrictEqual(dependencyGraph(baseLock), dependencyGraph(buildLock))) {
    throw new Error("Dependency changes require an immutable full release.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertDeveloperLocksCompatible(fs.readFileSync(process.argv[2], "utf8"), fs.readFileSync(process.argv[3], "utf8"));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
