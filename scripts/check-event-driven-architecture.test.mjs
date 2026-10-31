import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const checker = fileURLToPath(new URL("./check-event-driven-architecture.mjs", import.meta.url));
const marker = "// event-driven-allow: bounded message-source integrity reconciliation\n";
function check(t, file, text) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "source-integrity-exception-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text);
  return spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
}
test("the source-integrity exception is confined to its documented owner", t => {
  const allowed = check(t, "src/manager/messageHistorySearchService.ts", marker + "setInterval(reconcileKnownSources, 60000);");
  assert.equal(allowed.status, 0); assert.match(allowed.stdout, /Shared\/NAS files/);
  const otherOwner = check(t, "src/otherBusiness.ts", marker + "setInterval(pollBusiness, 5000);");
  assert.equal(otherOwner.status, 1);
  const unmarked = check(t, "src/manager/messageHistorySearchService.ts", "setInterval(pollBusiness, 5000);");
  assert.equal(unmarked.status, 1);
  const tooFrequent = check(t, "src/manager/messageHistorySearchService.ts", marker + "setInterval(reconcileKnownSources, 5000);");
  assert.equal(tooFrequent.status, 1);
});
