import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(
  fileURLToPath(new URL("./controlPlaneRoutes.ts", import.meta.url)),
  "utf8"
);

function recentMemoryGetBranch(): string {
  const start = source.indexOf('if (request.method === "GET" && resource === "memory/recent")');
  const end = source.indexOf('if (request.method === "GET" && resource === "memory/consolidated")', start);
  assert.ok(start >= 0 && end > start, "recent-memory GET branch must remain explicit");
  return source.slice(start, end);
}

test("recent-memory detail GET is pure in read-only mode and fenced in writable mode", () => {
  const branch = recentMemoryGetBranch();
  const readOnlyStart = branch.indexOf("if (managerReadOnly)");
  const writableStart = branch.indexOf("const context = roleStorageRequestContext(request, response)");
  const listStart = branch.lastIndexOf("managerReadWorkerPool.queryRoleMemoryCatalog");
  assert.ok(readOnlyStart > 0 && writableStart > readOnlyStart, "detail GET must split read-only and writable paths");
  assert.ok(listStart > writableStart, "recent-memory list must remain a read-worker query");
  const readOnlyDetail = branch.slice(readOnlyStart, writableStart);
  const writableDetail = branch.slice(writableStart, listStart);
  const list = branch.slice(listStart);

  assert.match(readOnlyDetail, /managerReadWorkerPool\.queryRecentMemoryDetail\(roleDir, itemId\)/);
  assert.doesNotMatch(readOnlyDetail, /touchRecentMemory\(|respondRoleStorageCommit\(/);
  assert.match(writableDetail, /resolveRoleStorageApplication\(\)\.commands\.touchRecentMemory\(roleId, itemId, context\)/);
  assert.match(
    writableDetail,
    /respondRoleStorageCommit\(\s*response,\s*200,\s*committed\.operationId,\s*committed\.projection\.memory,\s*committed\.projection\.revision\s*\)/
  );
  assert.doesNotMatch(writableDetail, /\.queries\.memory\(|getRecentMemory\(/);
  assert.match(list, /managerReadWorkerPool\.queryRoleMemoryCatalog\(roleDir, "recent", itemId\)/);
  assert.doesNotMatch(list, /touchRecentMemory\(/);
});
