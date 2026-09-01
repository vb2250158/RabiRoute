import assert from "node:assert/strict";
import test from "node:test";
import { memoryConsolidationFailureDiagnostic } from "./memoryConsolidationDiagnostics.js";

test("memory consolidation diagnostics never expose raw paths or secret-like error text", () => {
  const raw = Object.assign(
    new Error("Cannot read C:\\Users\\example-user\\private-role\\persona.md; token=example-secret"),
    { code: "EACCES" }
  );
  const diagnostic = memoryConsolidationFailureDiagnostic(raw);
  const serialized = JSON.stringify(diagnostic);

  assert.equal(diagnostic.code, "EACCES");
  assert.match(diagnostic.runtimeLogSuffix, /^errorCode=EACCES$/);
  assert.doesNotMatch(serialized, /example-user|private-role|persona\.md|example-secret/);
});

test("memory consolidation diagnostics reject an unsafe error code", () => {
  const diagnostic = memoryConsolidationFailureDiagnostic({
    code: "C:\\Users\\example-user\\private.txt"
  });

  assert.equal(diagnostic.code, "MEMORY_CONSOLIDATION_FAILED");
  assert.doesNotMatch(JSON.stringify(diagnostic), /example-user|private\.txt/);
});
