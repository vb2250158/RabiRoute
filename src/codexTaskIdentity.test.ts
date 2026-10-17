import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalCodexWorkspacePath,
  createCodexWorkspaceMatcher,
  setCodexWorkspaceRealpathForTest,
  isCodexTaskId,
  sameCodexWorkspace
} from "./codexTaskIdentity.js";

test("Codex task ids accept UUID values and reject route names", () => {
  assert.equal(isCodexTaskId("019f0000-0000-7000-8000-000000000001"), true);
  assert.equal(isCodexTaskId("urn:uuid:019f0000-0000-7000-8000-000000000001"), true);
  assert.equal(isCodexTaskId("RabiLink"), false);
  assert.equal(isCodexTaskId("thread-1"), false);
});

test("Codex workspace comparison normalizes Windows namespace and case", () => {
  assert.equal(
    canonicalCodexWorkspacePath("\\\\?\\UNC\\Server\\Share\\DigitalLife\\"),
    "//server/share/digitallife"
  );
  assert.equal(
    sameCodexWorkspace("\\\\?\\UNC\\Server\\Share\\DigitalLife", "\\\\server\\share\\digitallife\\"),
    true
  );
});

test("workspace matcher never realpaths rows on other drives and caches slow or failed network drives", { skip: process.platform !== "win32" }, t => {
  const calls: string[] = [];
  let clock = 0;
  const realNow = Date.now;
  Date.now = () => clock;
  t.after(() => { Date.now = realNow; setCodexWorkspaceRealpathForTest(); });
  setCodexWorkspaceRealpathForTest(value => {
    calls.push(value);
    if (/^z:/i.test(value)) { clock += 8_000; throw new Error("ETIMEDOUT"); }
    return value;
  });
  const matches = createCodexWorkspaceMatcher(["D:\\Rabi"]);
  calls.length = 0;
  const rows = Array.from({ length: 537 }, (_, index) => `Z:\\share\\project-${index}`);
  assert.equal(rows.filter(matches).length, 0);
  assert.equal(matches("\\\\nas\\share\\Rabi"), false);
  assert.deepEqual(calls, [], "rows on another drive or UNC must not be realpath'd");
  assert.equal(matches("d:\\rabi\\"), true);
  assert.equal(matches("D:\\Other"), false);

  calls.length = 0;
  const onNas = createCodexWorkspaceMatcher(["Z:\\share\\Rabi"]);
  for (const row of rows) onNas(row);
  assert.equal(onNas("Z:\\share\\Rabi"), true);
  assert.ok((calls as string[]).filter(call => /^z:/i.test(call)).length <= 1, "a slow/failed network drive is realpath'd at most once");
  canonicalCodexWorkspacePath("Z:\\share\\project-1");
  assert.ok((calls as string[]).filter(call => /^z:/i.test(call)).length <= 1);
  assert.equal(canonicalCodexWorkspacePath("\\\\nas\\share\\x"), "//nas/share/x");
  assert.ok(!(calls as string[]).some(call => call.startsWith("\\\\")), "UNC paths are never realpath'd");
});
