import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalCodexWorkspacePath,
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
